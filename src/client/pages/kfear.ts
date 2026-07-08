import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * K-공포지수 (0~100) + 캐피출레이션 3신호 — 코스피/코스닥 개별 계산.
 *
 * 검증된 레퍼런스(capitulation_backtest.py / fear_index.py / fear_executor.py)의
 * 계산을 TypeScript로 그대로 이식한 것이다. 로직·상수를 임의로 바꾸지 말 것.
 * 핵심 원칙: 절대값이 아니라 **252일 롤링 분위수(roll_pct)**로 정규화해 레짐 변화를
 * 흡수한다. 모든 입력 시리즈는 일별(거래일) 오름차순이라고 가정한다(sliceLastYear).
 *
 * 3신호 (build_signals):
 *   S1 신용잔고 : 252일 피크 대비 ≤−8% & 10일 ≤−3% & 지수 10일 수익률 < 0
 *   S2 반대매매 : 비중 252일 분위수 ≥0.95 스파이크(최근 6일) & 2일 연속↓
 *   S3 이격도60 : 종가/60일SMA×100 ≤92  또는  252일 분위수 ≤0.05
 * FEAR (build_fear): 4성분 동일가중 평균 ×100, 값이 높을수록 공포
 *   F1 = 1 − pct252(신용 10일 변화율)   (청산 속도, 시장별)
 *   F2 =     pct252(반대매매 비중)        (강제 매물, 시장 공통)
 *   F3 = 1 − pct252(60일 이격도)          (가격 낙폭)
 *   F4 =     pct252(20일 실현변동성)      (패닉 강도 — VKOSPI 대용)
 * F1과 S1의 차이: F1은 신용잔고의 *속도*(10일 변화율), S1은 *깊이*(피크 대비 누적
 * 낙폭). 같은 재료의 다른 측면이라 상관은 있지만 일치하지 않는다.
 */

// ── 상수 (레퍼런스 기본값 고정) ──
const PCT_WIN = 252; // 분위수 롤링 창
const SPIKE_LOOKBACK = 6; // 스파이크 탐색 창(거래일)
const SPIKE_PCT = 0.95; // 상위 5%
const CREDIT_DD = -0.08; // 피크 대비 −8%
const CREDIT_10D = -0.03; // 10거래일 −3%
const PEAK_MINP = 200; // 피크 롤링 최소 관측
const DISP_N = 60; // 이격도 이평 기간
const DISP_ABS = 92.0; // 이격도 절대 과매도선
const DISP_PCT = 0.05; // 이격도 분위 과매도선
const RV_N = 20; // 실현변동성 기간
const FEAR_ARM = 90; // 매수국면 FEAR 임계
const DD2 = -0.15;
const DD3 = -0.25; // 사이징 depth 단계

export type Grade = "STRONG" | "BUY" | "ARMED" | "WATCH" | "IDLE";
export type CapLevel = 0 | 1 | 2 | 3;
export const GRADE_LABEL: Record<Grade, string> = {
  STRONG: "최강 매수국면",
  BUY: "매수국면",
  ARMED: "장전",
  WATCH: "관찰",
  IDLE: "대기",
};

export interface SignalView {
  key: string;
  met: boolean;
  value: string;
  criteria: string;
  detail: string;
  level: CapLevel;
}

export interface MarketFear {
  market: "코스피" | "코스닥";
  hasData: boolean;
  asOf: number | null; // 마지막 거래일(ms)
  fear: number | null; // 0~100
  components: { F1: number | null; F2: number | null; F3: number | null; F4: number | null };
  grade: Grade;
  size: string;
  nOn: number;
  all3: boolean;
  creditDd: number | null;
  signals: SignalView[];
  fearHistory: SeriesPoint[];
  // 코스닥 전용:
  regime?: "SYSTEMIC" | "KOSDAQ_ONLY";
  signaling?: boolean; // 코스닥 신호 점등(FEAR≥90 or ALL3) 여부
}

export interface KFearResult {
  kospi: MarketFear;
  kosdaq: MarketFear;
  kospiAccompanies: boolean;
}

// ── 시계열 헬퍼 (pandas 동작 이식) ──

/** source 값을 targetDates에 맞춰 ffill (target 이전 최근값; 첫 관측 전은 NaN). */
function alignFfill(targetDates: number[], source: SeriesPoint[]): number[] {
  const out = new Array<number>(targetDates.length).fill(NaN);
  let j = 0;
  let last = NaN;
  for (let i = 0; i < targetDates.length; i++) {
    while (j < source.length && source[j].t <= targetDates[i]) {
      last = source[j].v;
      j++;
    }
    out[i] = last;
  }
  return out;
}

/** roll_pct: 현재값이 최근 win개(자기 포함, 전부 유한) 중 몇 분위(0~1)인가.
 *  창에 NaN이 하나라도 있으면(min_periods=win 미달) NaN. `(w <= w[-1]).mean()`. */
function rollPct(arr: number[], win = PCT_WIN): number[] {
  const n = arr.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = win - 1; i < n; i++) {
    const cur = arr[i];
    if (!Number.isFinite(cur)) continue;
    let le = 0;
    let ok = true;
    for (let j = i - win + 1; j <= i; j++) {
      const v = arr[j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      if (v <= cur) le++;
    }
    if (ok) out[i] = le / win;
  }
  return out;
}

/** rolling(win, min_periods=minP).max() — 창 내 유한값이 minP개 이상일 때 최대. */
function rollMax(arr: number[], win: number, minP: number): number[] {
  const n = arr.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let mx = -Infinity;
    let cnt = 0;
    for (let j = Math.max(0, i - win + 1); j <= i; j++) {
      const v = arr[j];
      if (Number.isFinite(v)) {
        cnt++;
        if (v > mx) mx = v;
      }
    }
    if (cnt >= minP) out[i] = mx;
  }
  return out;
}

/** rolling(win).mean() — 창이 전부 유한일 때만(min_periods=win). */
function rollMean(arr: number[], win: number): number[] {
  const n = arr.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = win - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - win + 1; j <= i; j++) {
      if (!Number.isFinite(arr[j])) {
        ok = false;
        break;
      }
      sum += arr[j];
    }
    if (ok) out[i] = sum / win;
  }
  return out;
}

/** rolling(win).std(ddof=1) — 표본표준편차, 창이 전부 유한일 때만. */
function rollStd(arr: number[], win: number): number[] {
  const n = arr.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = win - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - win + 1; j <= i; j++) {
      if (!Number.isFinite(arr[j])) {
        ok = false;
        break;
      }
      sum += arr[j];
    }
    if (!ok) continue;
    const mean = sum / win;
    let ss = 0;
    for (let j = i - win + 1; j <= i; j++) {
      const d = arr[j] - mean;
      ss += d * d;
    }
    out[i] = Math.sqrt(ss / (win - 1));
  }
  return out;
}

/** pct_change(k): arr[i]/arr[i−k] − 1. */
function pctChange(arr: number[], k: number): number[] {
  const n = arr.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = k; i < n; i++) {
    const prev = arr[i - k];
    const cur = arr[i];
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev !== 0) out[i] = cur / prev - 1;
  }
  return out;
}

/** NaN을 건너뛴 평균 (pandas mean(axis=1) skipna=True). 전부 NaN이면 NaN. */
function meanSkip(vals: number[]): number {
  let sum = 0;
  let cnt = 0;
  for (const v of vals) {
    if (Number.isFinite(v)) {
      sum += v;
      cnt++;
    }
  }
  return cnt ? sum / cnt : NaN;
}

/** 상위 꼬리 강도(②): 스파이크 분위 0..1 → 0 관망 / 1 경계 / 2 공포(≥0.95) / 3 심각(≥0.99). */
function upperTailLevel(pct: number): CapLevel {
  if (pct >= 0.99) return 3;
  if (pct >= 0.95) return 2;
  if (pct >= 0.9) return 1;
  return 0;
}

interface Built {
  hasData: boolean;
  asOf: number | null;
  fear: number | null;
  components: { F1: number | null; F2: number | null; F3: number | null; F4: number | null };
  nOn: number;
  all3: boolean;
  creditDd: number | null;
  signals: SignalView[];
  fearHistory: SeriesPoint[];
}

const nn = (v: number): number | null => (Number.isFinite(v) ? v : null);
const fmtPct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const fmtPctile = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%ile` : "—");

/**
 * 한 시장(코스피 or 코스닥)의 3신호 + FEAR를 계산. price는 그 시장 지수 종가,
 * credit은 그 시장 신용거래융자(유가 or 코스닥), liq는 공통 반대매매 비중.
 */
function buildMarket(price: SeriesPoint[], credit: SeriesPoint[], liq: SeriesPoint[]): Built {
  const empty: Built = {
    hasData: false,
    asOf: null,
    fear: null,
    components: { F1: null, F2: null, F3: null, F4: null },
    nOn: 0,
    all3: false,
    creditDd: null,
    fearHistory: [],
    signals: [
      { key: "S1 신용청산", met: false, value: "—", criteria: "1년 피크 −8%↓ & 10일 −3%↓ & 지수 10일↓", detail: "데이터 없음", level: 0 },
      { key: "S2 반대매매", met: false, value: "—", criteria: "비중 1년 상위5% 스파이크 & 2일 연속↓", detail: "데이터 없음", level: 0 },
      { key: "S3 이격도60", met: false, value: "—", criteria: "이격도 ≤92 or 1년 하위5%", detail: "데이터 없음", level: 0 },
    ],
  };
  if (price.length < DISP_N) return empty;

  const dates = price.map((p) => p.t);
  const close = price.map((p) => p.v);
  const n = close.length;
  const creditA = alignFfill(dates, credit);
  const liqA = alignFfill(dates, liq);

  // S1 신용잔고
  const peak = rollMax(creditA, PCT_WIN, PEAK_MINP);
  const creditDd = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(creditA[i]) && Number.isFinite(peak[i]) && peak[i] !== 0) creditDd[i] = creditA[i] / peak[i] - 1;
  }
  const credit10d = pctChange(creditA, 10);
  const idx10d = pctChange(close, 10);

  // S2 반대매매
  const liqPct = rollPct(liqA, PCT_WIN);
  const spike = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - SPIKE_LOOKBACK + 1); j <= i; j++) {
      if (liqPct[j] >= SPIKE_PCT) {
        spike[i] = true;
        break;
      }
    }
  }
  const decl2 = new Array<boolean>(n).fill(false);
  for (let i = 2; i < n; i++) decl2[i] = liqA[i] < liqA[i - 1] && liqA[i - 1] < liqA[i - 2];

  // S3 이격도
  const ma60 = rollMean(close, DISP_N);
  const disp = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) if (Number.isFinite(ma60[i]) && ma60[i] !== 0) disp[i] = (close[i] / ma60[i]) * 100;
  const dispPct = rollPct(disp, PCT_WIN);

  // FEAR 성분
  const f1 = rollPct(credit10d, PCT_WIN).map((v) => (Number.isFinite(v) ? 1 - v : NaN)); // 1 − pct
  const f2 = liqPct;
  const f3 = dispPct.map((v) => (Number.isFinite(v) ? 1 - v : NaN));
  const logret = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) if (close[i] > 0 && close[i - 1] > 0) logret[i] = Math.log(close[i] / close[i - 1]);
  const rv = rollStd(logret, RV_N).map((v) => (Number.isFinite(v) ? v * Math.sqrt(252) * 100 : NaN));
  const f4 = rollPct(rv, PCT_WIN);

  const fear = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const m = meanSkip([f1[i], f2[i], f3[i], f4[i]]);
    if (Number.isFinite(m)) fear[i] = m * 100;
  }

  const s1 = new Array<boolean>(n).fill(false);
  const s3 = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    s1[i] = creditDd[i] <= CREDIT_DD && credit10d[i] <= CREDIT_10D && idx10d[i] < 0;
    s3[i] = disp[i] <= DISP_ABS || dispPct[i] <= DISP_PCT;
  }
  const s2 = spike.map((sp, i) => sp && decl2[i]);

  const fearHistory: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(fear[i])) fearHistory.push({ t: dates[i], v: Math.round(fear[i] * 10) / 10 });

  // 최신 행
  const L = n - 1;
  const nOn = (s1[L] ? 1 : 0) + (s2[L] ? 1 : 0) + (s3[L] ? 1 : 0);

  // S1 강도 = 피크 되돌림 깊이 / S2 = 최근 스파이크 분위 / S3 = 과매도 깊이
  const s1Level: CapLevel = creditDd[L] <= -0.2 ? 3 : creditDd[L] <= -0.08 ? 2 : creditDd[L] <= -0.04 ? 1 : 0;
  let s2Max = 0;
  for (let j = Math.max(0, L - SPIKE_LOOKBACK + 1); j <= L; j++) if (Number.isFinite(liqPct[j])) s2Max = Math.max(s2Max, liqPct[j]);
  const s2Level = upperTailLevel(s2Max);
  const s3Level: CapLevel =
    dispPct[L] <= 0.01 || disp[L] <= 88 ? 3 : dispPct[L] <= 0.05 || disp[L] <= 92 ? 2 : dispPct[L] <= 0.15 || disp[L] <= 96 ? 1 : 0;

  const dev = Number.isFinite(disp[L]) ? disp[L] - 100 : NaN;
  const signals: SignalView[] = [
    {
      key: "S1 신용청산",
      met: s1[L],
      value: Number.isFinite(creditDd[L]) ? `DD ${fmtPct(creditDd[L])}` : "—",
      criteria: "1년 피크 −8%↓ & 10일 −3%↓ & 지수 10일↓",
      detail: `피크대비 ${fmtPct(creditDd[L])} · 10일 ${fmtPct(credit10d[L])} · 지수10일 ${fmtPct(idx10d[L])}`,
      level: s1Level,
    },
    {
      key: "S2 반대매매",
      met: s2[L],
      value: Number.isFinite(liqA[L]) ? `${liqA[L].toFixed(1)}%` : "—",
      criteria: "비중 1년 상위5% 스파이크 & 2일 연속↓",
      detail: `비중 1년 ${fmtPctile(liqPct[L])}${spike[L] ? " · 상위5% 스파이크" : ""}${s2[L] ? " · 2일↓" : ""}`,
      level: s2Level,
    },
    {
      key: "S3 이격도60",
      met: s3[L],
      value: Number.isFinite(disp[L]) ? disp[L].toFixed(1) : "—",
      criteria: "이격도 ≤92 or 1년 하위5%",
      detail: `60일선 ${Number.isFinite(dev) ? (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%" : "—"} · 1년 하위 ${fmtPctile(dispPct[L])}`,
      level: s3Level,
    },
  ];

  return {
    hasData: true,
    asOf: dates[L],
    fear: nn(fear[L]),
    components: { F1: nn(f1[L]), F2: nn(f2[L]), F3: nn(f3[L]), F4: nn(f4[L]) },
    nOn,
    all3: nOn === 3,
    creditDd: nn(creditDd[L]),
    signals,
    fearHistory,
  };
}

/** phase/사이징 (fear_executor + depth 사이징). */
function phase(fear: number | null, all3: boolean, nOn: number, creditDd: number | null): { grade: Grade; size: string } {
  const f = fear ?? NaN;
  let grade: Grade;
  if (f >= FEAR_ARM && all3) grade = "STRONG";
  else if (f >= FEAR_ARM && nOn >= 2) grade = "BUY";
  else if (f >= FEAR_ARM) grade = "ARMED";
  else if (nOn >= 2) grade = "WATCH";
  else grade = "IDLE";

  const dd = creditDd ?? NaN;
  let size: string;
  if (dd <= DD3) size = "3차까지(≈100%)";
  else if (dd <= DD2) size = "2차까지(≈70%)";
  else if (dd <= CREDIT_DD) size = "1차(≈40%)";
  else size = "소액 탐색(≤20%)";
  return { grade, size };
}

/** Internal helpers exposed for unit tests (not used by the UI). */
export const __test = { alignFfill, rollPct, rollMax, rollMean, rollStd, pctChange, meanSkip, buildMarket, phase };

export function computeKFear(snap: MarketSnapshot): KFearResult {
  const h = snap.history;
  const liq = h.forcedLiqRatio ?? [];
  const bk = buildMarket(h.kospiClose ?? [], h.creditKospi ?? [], liq);
  const bq = buildMarket(h.kosdaqClose ?? [], h.creditKosdaq ?? [], liq);

  const pk = phase(bk.fear, bk.all3, bk.nOn, bk.creditDd);
  const pq = phase(bq.fear, bq.all3, bq.nOn, bq.creditDd);

  // 코스피 동반 판정 (3-3): 코스닥 신호의 신뢰 등급을 좌우.
  const kospiAccompanies = (bk.fear ?? NaN) >= FEAR_ARM || bk.all3 || (bk.creditDd ?? NaN) <= -0.15;
  const kosdaqSignaling = (bq.fear ?? NaN) >= FEAR_ARM || bq.all3;

  const kospi: MarketFear = { market: "코스피", ...bk, grade: pk.grade, size: pk.size };
  const kosdaq: MarketFear = {
    market: "코스닥",
    ...bq,
    grade: pq.grade,
    size: pq.size,
    regime: kospiAccompanies ? "SYSTEMIC" : "KOSDAQ_ONLY",
    signaling: kosdaqSignaling,
  };
  return { kospi, kosdaq, kospiAccompanies };
}
