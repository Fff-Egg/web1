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

/**
 * 등급별 사이징 계수(곱셈). 코스피+코스닥 통합 백테스트(2020~, n=10~31) 기반:
 * 6개월 기대수익이 STRONG 20.3% > BUY 16.7% > ARMED 13.5% > WATCH 11.5%로 단조감소.
 * ⚠️ **방향성(STRONG>BUY>ARMED>WATCH)만 신뢰구간** — 어느 등급이든 6달 +11~20%라 전부
 * 플러스였고, 계수 소수점 둘째자리는 노이즈다. "STRONG 풀·WATCH 절반" 수준의 차등일 뿐.
 */
export const GRADE_COEF: Record<Grade, number> = { STRONG: 1.0, BUY: 0.75, ARMED: 0.65, WATCH: 0.45, IDLE: 0 };
/** 코스닥 단독(KOSDAQ_ONLY): 6달 승률 50%(반반)·n=5라 계수 곱셈 대신 **비율 상한(%)**을 씌운다
 *  ("반반 도박엔 크게 안 건다"). depth·등급이 뭐든 코스닥 단독이면 이 상한까지만. */
export const KOSDAQ_ONLY_CAP = 30;

/** 최종 권장 비중 분해. */
export interface Sizing {
  pct: number; // 최종 권장 비중 %
  base: number; // depth(신용 DD) 기준 %
  coef: number; // 등급 계수
  capped: boolean; // 코스닥 단독 상한 적용됨
}

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
  /** 최종 권장 비중 = depth 기준% × 등급계수 (코스닥 단독이면 30% 상한). */
  sizing: Sizing;
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

const DAY_MS = 86400000;
/**
 * KST 거래일 정수 키. 소스마다 타임스탬프 규약이 달라도(KOFIA=Date.UTC 자정,
 * TradingView 일봉=UTC자정 or 전일 15:00Z=KST자정) **같은 거래일이면 같은 키**가 되게
 * +9h 후 날짜로 내림. 이걸로 정렬하면 TV 규약이 무엇이든 KOFIA와 결정적으로 맞아,
 * "지수-앞선 하루가 ffill로 붙어 KOFIA가 1일 밀리는" 문제가 사라진다.
 */
const kstDay = (t: number) => Math.floor((t + 9 * 3600000) / DAY_MS);

/** source 값을 targetDates에 맞춰 정렬 (KST 거래일 기준 as-of: target 거래일 이하 최근값,
 *  첫 관측 전은 NaN). 레퍼런스 `reindex(px.index).ffill()`와 동치이되 tz 규약 차이에 견고. */
function alignFfill(targetDates: number[], source: SeriesPoint[]): number[] {
  const out = new Array<number>(targetDates.length).fill(NaN);
  let j = 0;
  let last = NaN;
  for (let i = 0; i < targetDates.length; i++) {
    const key = kstDay(targetDates[i]);
    while (j < source.length && kstDay(source[j].t) <= key) {
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

/**
 * endIx로 끝나는 win개 창의 q분위 **임계값**(원값) — rollPct의 `(count≤v)/win ≥ q`
 * 규약과 일치하게 오름차순 정렬 후 index `ceil(q*win)-1`을 고른다(그 값 이상이면 상위
 * (1−q) 안). "상위5% 컷이 반대매매 비중 몇 %인가"를 화면에 보여주려고. 창 부족/NaN이면 null.
 */
function windowQuantile(arr: number[], endIx: number, q: number, win = PCT_WIN): number | null {
  if (endIx < win - 1) return null;
  const w: number[] = [];
  for (let j = endIx - win + 1; j <= endIx; j++) {
    if (!Number.isFinite(arr[j])) return null;
    w.push(arr[j]);
  }
  w.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(win - 1, Math.ceil(q * win) - 1));
  return w[idx];
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
/** 분위수(0..1) → "상위 X%" (높을수록 공포: 반대매매). p=0.86 → 상위 14%.
 *  호출부가 "1년"을 앞에 붙이므로 극단은 "최고권"만 반환(1년 중복 방지). */
const topPctLabel = (p: number): string => {
  if (!Number.isFinite(p)) return "—";
  const x = Math.round((1 - p) * 100);
  return x <= 0 ? "최고권" : `상위 ${x}%`;
};
/** 분위수(0..1) → "하위 X%" (낮을수록 공포: 이격도). p=0.00 → 최저권. */
const botPctLabel = (p: number): string => {
  if (!Number.isFinite(p)) return "—";
  const x = Math.round(p * 100);
  return x <= 0 ? "최저권" : `하위 ${x}%`;
};
/** M/D from a UTC-epoch trading-day timestamp. */
const fmtMD = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

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
  // KOFIA(신용·반대매매)는 T+1 공표라 지수보다 하루+ 뒤처진다. 지수가 앞선 날은
  // KOFIA가 ffill(전일값 반복)되어 S2의 "2일 연속↓" 같은 신호가 flat으로 깨진다.
  // → "오늘"(평가 기준일)을 KOFIA가 실제로 존재하는 마지막 거래일에 맞춘다
  // (문서 6-5: 가장 최근 available 날짜 = 기준일). 그 이후 지수-앞선 ffill 구간은 제외.
  // KST 거래일 키로 자른다(tz 규약 무관하게 결정적). 지수를 KOFIA 최신 거래일까지만 남겨,
  // 지수-앞선 하루가 ffill로 신호를 흐리지 않게.
  const lastKofiaKey = Math.min(
    credit.length ? kstDay(credit[credit.length - 1].t) : Infinity,
    liq.length ? kstDay(liq[liq.length - 1].t) : Infinity,
  );
  const priceEff = Number.isFinite(lastKofiaKey) ? price.filter((p) => kstDay(p.t) <= lastKofiaKey) : price;
  if (priceEff.length < DISP_N) return empty;

  const dates = priceEff.map((p) => p.t);
  const close = priceEff.map((p) => p.v);
  const n = close.length;
  const creditA = alignFfill(dates, credit);
  const liqA = alignFfill(dates, liq);

  // 신용 히스토리 커버리지: 최근 252창에 유한 신용값이 PEAK_MINP 미만이면 peak/DD가 NaN이
  // 되어 S1이 '조용히 항상 미충족'·F1이 NaN이 된다(부분수집 사고). '데이터 부족'으로 명시.
  let creditFinite252 = 0;
  for (let i = Math.max(0, n - PCT_WIN); i < n; i++) if (Number.isFinite(creditA[i])) creditFinite252++;
  const creditSparse = creditFinite252 < PEAK_MINP;

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
  // 상위5%(분위 0.95) 컷이 지금 창에선 실제 반대매매 비중 몇 %인지 — 화면 표기용.
  const spikeCut = windowQuantile(liqA, n - 1, SPIKE_PCT, PCT_WIN);

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

  // 차트는 4성분이 **모두** 찬 뒤부터만(성분별 워밍업이 달라 — F4 20+252, F3 60+252 등
  // — 초기엔 일부 성분만으로 FEAR가 계산돼 왜곡됨). 완전 워밍업(~311거래일) 지점만 그림.
  const fearHistory: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(f1[i]) && Number.isFinite(f2[i]) && Number.isFinite(f3[i]) && Number.isFinite(f4[i])) {
      fearHistory.push({ t: dates[i], v: Math.round(fear[i] * 10) / 10 });
    }
  }

  // 최신 행
  const L = n - 1;
  const nOn = (s1[L] ? 1 : 0) + (s2[L] ? 1 : 0) + (s3[L] ? 1 : 0);

  // S1 강도 = 피크 되돌림 깊이 / S2 = 최근 스파이크 분위 / S3 = 과매도 깊이
  const s1Level: CapLevel = creditDd[L] <= -0.2 ? 3 : creditDd[L] <= -0.08 ? 2 : creditDd[L] <= -0.04 ? 1 : 0;
  let s2Max = 0;
  for (let j = Math.max(0, L - SPIKE_LOOKBACK + 1); j <= L; j++) if (Number.isFinite(liqPct[j])) s2Max = Math.max(s2Max, liqPct[j]);
  const s2Level = upperTailLevel(s2Max);
  // 6일 창의 **정점**(반대매매 비중 최고일) — 최신 스파이크가 아니라 투매가 어디서
  // 꺾였는지 기준점을 보여준다(예: 7/9 10.2% 정점 → 7/10 5.7%면 정점은 7/9).
  let peakIdx = -1;
  for (let j = Math.max(0, L - SPIKE_LOOKBACK + 1); j <= L; j++) {
    if (!Number.isFinite(liqA[j])) continue;
    if (peakIdx < 0 || liqA[j] > liqA[peakIdx]) peakIdx = j;
  }
  const peakAgo = peakIdx < 0 ? Infinity : L - peakIdx;
  const hasSpike = spike[L]; // 6일 창에 상위5% 존재
  // 기준일 기준 연속 하락 일수(decl2 = 이게 ≥2). "0일처럼 보인다"는 혼란을 없애려고
  // 몇 일째 꺾이는 중인지 명시한다.
  let declStreak = 0;
  for (let i = L; i >= 1; i--) {
    if (liqA[i] < liqA[i - 1]) declStreak++;
    else break;
  }
  const s2Reason = s2[L]
    ? "2일 연속↓ 충족"
    : !hasSpike
      ? "6일 창에 상위5% 없음"
      : declStreak >= 1
        ? `${declStreak}일 연속↓ (2일 필요)`
        : "정점 후 아직 안 꺾임";
  const s2Note =
    peakIdx < 0
      ? "최근 상위5% 스파이크 없음"
      : `정점 ${liqA[peakIdx].toFixed(1)}% (${fmtMD(dates[peakIdx])}·${peakAgo}일전) · ${s2Reason}`;
  const s3Level: CapLevel =
    dispPct[L] <= 0.01 || disp[L] <= 88 ? 3 : dispPct[L] <= 0.05 || disp[L] <= 92 ? 2 : dispPct[L] <= 0.15 || disp[L] <= 96 ? 1 : 0;

  const dev = Number.isFinite(disp[L]) ? disp[L] - 100 : NaN;
  // 어느 조건으로 S3가 켜졌나 (절대 ≤92 or 레짐적응 하위5%).
  const s3Why = disp[L] <= DISP_ABS ? "이격도 ≤92 충족" : dispPct[L] <= DISP_PCT ? "1년 하위5% 충족" : "";
  const signals: SignalView[] = [
    {
      key: "S1 신용청산",
      met: s1[L],
      value: creditSparse ? "—" : Number.isFinite(creditDd[L]) ? `DD ${fmtPct(creditDd[L])}` : "—",
      criteria: "1년 피크 −8%↓ & 10일 −3%↓ & 지수 10일↓",
      detail: creditSparse
        ? "⚠️ 신용잔고 히스토리 부족 — S1/F1 비활성(수집 확인)"
        : `피크대비 ${fmtPct(creditDd[L])} · 10일 ${fmtPct(credit10d[L])} · 지수10일 ${fmtPct(idx10d[L])}`,
      level: s1Level,
    },
    {
      key: "S2 반대매매",
      met: s2[L],
      value: Number.isFinite(liqA[L]) ? `${liqA[L].toFixed(1)}%` : "—",
      criteria: `비중 1년 상위5%${spikeCut !== null ? `(=${spikeCut.toFixed(1)}% 이상)` : ""} 스파이크(6일내) & 2일 연속↓`,
      detail: `비중 1년 ${topPctLabel(liqPct[L])} · ${s2Note}`,
      level: s2Level,
    },
    {
      key: "S3 이격도60",
      met: s3[L],
      value: Number.isFinite(disp[L]) ? disp[L].toFixed(1) : "—",
      criteria: "이격도 ≤92 or 1년 하위5%",
      detail: `60일선 대비 ${Number.isFinite(dev) ? (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%" : "—"} · 1년 ${botPctLabel(dispPct[L])}${s3Why ? " · " + s3Why : ""}`,
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

/** 신용 낙폭(depth) → 기준 비중 %. ≤−25=100 / ≤−15=70 / ≤−8=40 / else 20(소액 탐색). */
function depthBasePct(creditDd: number | null): number {
  const dd = creditDd ?? NaN;
  if (dd <= DD3) return 100;
  if (dd <= DD2) return 70;
  if (dd <= CREDIT_DD) return 40;
  return 20;
}

/**
 * 최종 권장 비중 = depth 기준% × 등급계수. 코스닥 단독(KOSDAQ_ONLY)이면 마지막에
 * **30% 상한**(계수 곱셈 아님 — 6달 승률 50%라 "반반 도박엔 크게 안 건다"). IDLE=0.
 */
export function computeSizing(grade: Grade, creditDd: number | null, regime?: "SYSTEMIC" | "KOSDAQ_ONLY"): Sizing {
  const base = depthBasePct(creditDd);
  const coef = GRADE_COEF[grade];
  let pct = base * coef;
  let capped = false;
  if (regime === "KOSDAQ_ONLY" && pct > KOSDAQ_ONLY_CAP) {
    pct = KOSDAQ_ONLY_CAP;
    capped = true;
  }
  return { pct: Math.round(pct), base, coef, capped };
}

/** Internal helpers exposed for unit tests (not used by the UI). */
export const __test = { alignFfill, rollPct, rollMax, rollMean, rollStd, pctChange, meanSkip, buildMarket, phase, computeSizing };

export function computeKFear(snap: MarketSnapshot): KFearResult {
  const h = snap.history;
  const liq = h.forcedLiqRatio ?? [];
  const bk = buildMarket(h.kospiClose ?? [], h.creditKospi ?? [], liq);
  const bq = buildMarket(h.kosdaqClose ?? [], h.creditKosdaq ?? [], liq);

  const pk = phase(bk.fear, bk.all3, bk.nOn, bk.creditDd);
  const pq = phase(bq.fear, bq.all3, bq.nOn, bq.creditDd);

  // 코스피 동반 판정 (3-3): 코스닥 신호의 신뢰 등급을 좌우.
  // FEAR≥90 단독으로 단순화 — FEAR는 4성분(신용속도·반대매매·이격도·변동성) 종합이라
  // "시장 전반이 골고루 공포에 빠졌나"를 하나로 압축한다. 과거 OR로 함께 봤던
  // ALL3(너무 빡셈)·DD≤-15%(신용 한 축)는 표본(n=11)에서 FEAR 위로 추가 기여 0이었음.
  const kospiAccompanies = (bk.fear ?? NaN) >= FEAR_ARM;
  const kosdaqSignaling = (bq.fear ?? NaN) >= FEAR_ARM || bq.all3;

  const kosdaqRegime = kospiAccompanies ? "SYSTEMIC" : "KOSDAQ_ONLY";
  const kospi: MarketFear = {
    market: "코스피",
    ...bk,
    grade: pk.grade,
    size: pk.size,
    sizing: computeSizing(pk.grade, bk.creditDd), // 코스피는 동반 상한 없음
  };
  const kosdaq: MarketFear = {
    market: "코스닥",
    ...bq,
    grade: pq.grade,
    size: pq.size,
    sizing: computeSizing(pq.grade, bq.creditDd, kosdaqRegime),
    regime: kosdaqRegime,
    signaling: kosdaqSignaling,
  };
  return { kospi, kosdaq, kospiAccompanies };
}
