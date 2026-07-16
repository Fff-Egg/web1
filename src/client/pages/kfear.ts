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
 *   S2 반대매매 : 반대매매 **금액** 스파이크(6일내 분위≥0.95) & 2일 연속↓ (v5 복원)
 *   S3 이격도60 : 종가/60일SMA×100 ≤92  또는  252일 분위수 ≤0.05
 * FEAR (build_fear): 4성분 동일가중 평균 ×100, 값이 높을수록 공포
 *   F1 = 1 − pct252(신용 10일 변화율)   (청산 속도, 시장별)
 *   F2 =     pct252(반대매매 **금액**)     (v4 — 비중 아님, 강제 매물, 시장 공통)
 *   F3 = 1 − pct252(60일 이격도)          (가격 낙폭)
 *   F4 =     pct252(20일 실현변동성)      (패닉 강도 — VKOSPI 대용)
 * F1과 S1의 차이: F1은 신용잔고의 *속도*(10일 변화율), S1은 *깊이*(피크 대비 누적
 * 낙폭). 같은 재료의 다른 측면이라 상관은 있지만 일치하지 않는다.
 */

// ── 상수 (레퍼런스 기본값 고정) ──
const PCT_WIN = 252; // 분위수 롤링 창
const SPIKE_PCT = 0.95; // 상위 5% (S2 스파이크: 반대매매금액 분위 ≥0.95)
const SPIKE_LOOKBACK = 6; // S2 스파이크 탐색 창(거래일) — v5 복원
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
  ARMED: "경계",
  WATCH: "관찰",
  IDLE: "평시",
};

/**
 * 등급별 사이징 계수(곱셈). 코스피+코스닥 통합 백테스트(2020~, n=10~31) 기반:
 * 6개월 기대수익이 STRONG 20.3% > BUY 16.7% > ARMED 13.5% > WATCH 11.5%로 단조감소.
 * ⚠️ **방향성(STRONG>BUY>ARMED>WATCH)만 신뢰구간** — 어느 등급이든 6달 +11~20%라 전부
 * 플러스였고, 계수 소수점 둘째자리는 노이즈다. "STRONG 풀·WATCH 절반" 수준의 차등일 뿐.
 */
/** v4 등급별 기본 비중(%). **depth 4단 사다리 폐지** — FEAR≥90 시점엔 신용이 이미 깊어
 *  중간단계 구분이 성과를 못 가름(병합 20건 중 18건이 이미 DD≤−8%). 신호개수가 등급을,
 *  등급이 비중을 직접 결정. 방향성(STRONG>BUY, ARMED는 BUY 아래 고정)만 신뢰. */
export const GRADE_WEIGHT: Record<Grade, number> = { STRONG: 100, BUY: 60, ARMED: 50, WATCH: 45, IDLE: 0 };
/** 코스닥 단독(코스피 미동반) → 0%(관찰). 동반 시 SYSTEMIC 자동 승격. */
export const KOSDAQ_SOLO_CAP = 0;
/** 이중 얕음 게이트 임계: 신용 DD·이격도 편차가 **둘 다** 얕으면(각 −8%/−7% 미달) ×0.5. */
export const SHALLOW_CREDIT = -8; // 신용 DD % (편차 아님, 음수)
export const SHALLOW_DISP = -7; // 이격도 편차 %

/** 사이징 경로: 코스닥 단독(0%) / 게이트 적용(×0.5) / 정상(×1.0) / 비중0(IDLE). */
export type SizingPath = "SOLO" | "GATED" | "FULL" | "NONE";

/** 최종 권장 비중 분해. */
export interface Sizing {
  pct: number; // 최종 권장 비중 %
  weight: number; // 등급 기본 비중(게이트 전)
  gate: number; // 이중 얕음 게이트 배수 (0.5 or 1.0)
  path: SizingPath;
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
  dispDev: number | null; // 60일선 대비 이격도 편차(%) — 게이트 표시
  signals: SignalView[];
  fearHistory: SeriesPoint[];
  s1History: SeriesPoint[];
  s2History: SeriesPoint[];
  s3History: SeriesPoint[];
  /** 최종 권장 비중 = 등급 기본 비중 × 이중 얕음게이트 (코스닥 단독이면 0%). */
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
  dispDev: number | null; // 60일선 대비 이격도 편차(%, 음수=이평 아래) — 이중 게이트 입력
  signals: SignalView[];
  fearHistory: SeriesPoint[];
  s1History: SeriesPoint[]; // 신용 DD(%) 추이 (임계 −8/−15)
  s2History: SeriesPoint[]; // 반대매매 금액 1년 분위(%) 추이 (임계 95=상위5%)
  s3History: SeriesPoint[]; // 60일선 이격도 편차(%) 추이 (임계 −8)
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
/** M/D from a UTC-epoch trading-day timestamp (S2 정점 날짜 표기). */
const fmtMD = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/**
 * 한 시장(코스피 or 코스닥)의 3신호 + FEAR를 계산. price는 그 시장 지수 종가,
 * credit은 그 시장 신용거래융자(유가 or 코스닥), liq는 공통 반대매매 비중.
 */
function buildMarket(price: SeriesPoint[], credit: SeriesPoint[], liq: SeriesPoint[], amount: SeriesPoint[] = []): Built {
  const empty: Built = {
    hasData: false,
    asOf: null,
    fear: null,
    components: { F1: null, F2: null, F3: null, F4: null },
    nOn: 0,
    all3: false,
    creditDd: null,
    dispDev: null,
    fearHistory: [],
    s1History: [],
    s2History: [],
    s3History: [],
    signals: [
      { key: "S1 신용청산", met: false, value: "—", criteria: "1년 피크 −8%↓ & 10일 −3%↓ & 지수 10일↓", detail: "데이터 없음", level: 0 },
      { key: "S2 반대매매", met: false, value: "—", criteria: "스파이크(6일내, 금액 1년 상위5%) & 2일 연속↓", detail: "데이터 없음", level: 0 },
      { key: "S3 이격도60", met: false, value: "—", criteria: "이격도 ≤−8% or 1년 하위5%", detail: "데이터 없음", level: 0 },
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
  const liqA = alignFfill(dates, liq); // 반대매매 비중(%) — 표시·폴백용
  // v4: F2·S2는 반대매매 **금액**(절대치) 분위수. 금액이 없으면(컬럼 미식별) 비중으로 폴백.
  const amtRaw = amount.length > 0 ? amount : liq;
  const amtA = alignFfill(dates, amtRaw);
  const usingAmount = amount.length > 0;

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

  // S2 반대매매 — v5: 반대매매 **금액** 스파이크(6일내 분위≥0.95) & 금액 2일 연속 하락.
  // 청산 파도가 정점을 찍고 잦아드는 것을 확인한 뒤 점등(통상 정점+2일). 스파이크 당일은
  // 금액이 오르는 중이라 OFF, 재급증(2차 파도) 시 decline2가 깨져 OFF, 동률(ffill 포함)은 감소 아님.
  const amtPct = rollPct(amtA, PCT_WIN); // 금액 분위수(F2·스파이크 판정 공통)
  const spike = amtPct.map((p) => Number.isFinite(p) && p >= SPIKE_PCT); // 상위5% 스파이크 당일
  const spike6 = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - SPIKE_LOOKBACK + 1); j <= i; j++) {
      if (spike[j]) { spike6[i] = true; break; }
    }
  }
  const decline2 = new Array<boolean>(n).fill(false); // 금액 2일 연속 '엄격' 감소(동률 제외)
  for (let i = 2; i < n; i++) decline2[i] = amtA[i] < amtA[i - 1] && amtA[i - 1] < amtA[i - 2];

  // S3 이격도
  const ma60 = rollMean(close, DISP_N);
  const disp = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) if (Number.isFinite(ma60[i]) && ma60[i] !== 0) disp[i] = (close[i] / ma60[i]) * 100;
  const dispPct = rollPct(disp, PCT_WIN);

  // FEAR 성분
  const f1 = rollPct(credit10d, PCT_WIN).map((v) => (Number.isFinite(v) ? 1 - v : NaN)); // 1 − pct
  const f2 = amtPct; // v4: 반대매매 **금액** 분위수(비중 아님 — 분모 왜곡 제거)
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
  const s2 = spike6.map((sp, i) => sp && decline2[i]); // v5: 스파이크(6일내) & 2일 연속↓

  // 차트는 4성분이 **모두** 찬 뒤부터만(성분별 워밍업이 달라 — F4 20+252, F3 60+252 등
  // — 초기엔 일부 성분만으로 FEAR가 계산돼 왜곡됨). 완전 워밍업(~311거래일) 지점만 그림.
  const fearHistory: SeriesPoint[] = [];
  const s1History: SeriesPoint[] = []; // 신용 DD %
  const s2History: SeriesPoint[] = []; // 반대매매 금액 분위 %
  const s3History: SeriesPoint[] = []; // 이격도 편차 %
  for (let i = 0; i < n; i++) {
    if (!(Number.isFinite(f1[i]) && Number.isFinite(f2[i]) && Number.isFinite(f3[i]) && Number.isFinite(f4[i]))) continue;
    fearHistory.push({ t: dates[i], v: Math.round(fear[i] * 10) / 10 });
    if (Number.isFinite(creditDd[i])) s1History.push({ t: dates[i], v: Math.round(creditDd[i] * 1000) / 10 });
    if (Number.isFinite(amtPct[i])) s2History.push({ t: dates[i], v: Math.round(amtPct[i] * 1000) / 10 });
    if (Number.isFinite(disp[i])) s3History.push({ t: dates[i], v: Math.round((disp[i] - 100) * 10) / 10 });
  }

  // 최신 행
  const L = n - 1;
  const nOn = (s1[L] ? 1 : 0) + (s2[L] ? 1 : 0) + (s3[L] ? 1 : 0);

  // S1 강도 = 피크 되돌림 깊이 / S2 = 금액 분위 / S3 = 과매도 깊이
  const s1Level: CapLevel = creditDd[L] <= -0.2 ? 3 : creditDd[L] <= -0.08 ? 2 : creditDd[L] <= -0.04 ? 1 : 0;
  const s2Level = upperTailLevel(amtPct[L]); // 반대매매 금액 분위수 강도
  // S2 표기: 6일 창의 **정점**(금액 최고일=스파이크)과 기준일 연속 하락 일수(v5 복원).
  let peakIdx = -1;
  for (let j = Math.max(0, L - SPIKE_LOOKBACK + 1); j <= L; j++) {
    if (!Number.isFinite(amtA[j])) continue;
    if (peakIdx < 0 || amtA[j] > amtA[peakIdx]) peakIdx = j;
  }
  const peakAgo = peakIdx < 0 ? Infinity : L - peakIdx;
  let s2Decl = 0; // 기준일 기준 연속 '엄격' 하락 일수
  for (let i = L; i >= 1; i--) {
    if (amtA[i] < amtA[i - 1]) s2Decl++;
    else break;
  }
  const s2Reason = s2[L]
    ? "2일 연속↓ 충족"
    : !spike6[L]
      ? "6일 내 상위5% 스파이크 없음"
      : s2Decl >= 1
        ? `${s2Decl}일 연속↓ (2일 필요)`
        : "정점 후 아직 안 꺾임";
  const s2Note =
    peakIdx < 0 || !spike6[L]
      ? "최근 6일 상위5% 스파이크 없음"
      : `정점 ${topPctLabel(amtPct[peakIdx])} (${fmtMD(dates[peakIdx])}·${peakAgo}일전) · ${s2Reason}`;
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
      criteria: `스파이크(6일내, 금액 1년 상위5%) & 2일 연속↓${usingAmount ? "" : " ⚠비중 폴백"}`,
      detail: `${s2Note}${usingAmount ? "" : " (금액 미수집→비중 분위)"}`,
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
    dispDev: Number.isFinite(dev) ? dev : null, // 60일선 대비 이격도 편차(%) — 게이트 입력
    signals,
    fearHistory,
    s1History,
    s2History,
    s3History,
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

/**
 * 이중 얕음 게이트 — 신용 DD(빚 청산 깊이)와 이격도 편차(가격 낙폭)는 거의 무상관(−0.04)
 * 독립 정보. **둘 다** 얕을 때만(신용>−8% AND 이격>−7%) 가짜바닥 위험 → ×0.5. 하나라도
 * 깊으면 정상(×1.0) — "하나만 얕음"은 실측 +23.8%로 오히려 최고라 깎지 않는다.
 * creditDd는 소수(−0.08), dispDev는 %(−7). 값이 없으면(null) '깊지 않음'=얕음으로 본다.
 */
export function shallowGate(creditDd: number | null, dispDev: number | null): number {
  const creditShallow = creditDd === null || creditDd * 100 > SHALLOW_CREDIT;
  const dispShallow = dispDev === null || dispDev > SHALLOW_DISP;
  return creditShallow && dispShallow ? 0.5 : 1.0;
}

/**
 * 최종 권장 비중 — v4 통합 로직. **우선순위 ①→② 엄수**:
 *   ① 코스닥 단독(코스피 미동반) → 0% (등급 무관, 관찰). [단독 6달 +0.5%·승률 50%·n=5]
 *   ② 등급 기본 비중 × 이중 얕음게이트. [STRONG도 게이트 적용 — 얕은 3신호 방어]
 * IDLE 등 비중 0이면 게이트 무의미(path=NONE).
 */
export function computeSizing(grade: Grade, creditDd: number | null, dispDev: number | null, isSolo: boolean): Sizing {
  const weight = GRADE_WEIGHT[grade];
  // ① 코스닥 단독 (최우선, 등급 무관)
  if (isSolo) return { pct: KOSDAQ_SOLO_CAP, weight, gate: 1, path: "SOLO" };
  // 비중 0(IDLE) → 게이트 무의미
  if (weight === 0) return { pct: 0, weight, gate: 1, path: "NONE" };
  // ② 등급 비중 × 이중 얕음게이트
  const gate = shallowGate(creditDd, dispDev);
  return { pct: Math.round(weight * gate), weight, gate, path: gate < 1 ? "GATED" : "FULL" };
}

/** Internal helpers exposed for unit tests (not used by the UI). */
export const __test = { alignFfill, rollPct, rollMax, rollMean, rollStd, pctChange, meanSkip, buildMarket, phase, computeSizing, shallowGate };

export function computeKFear(snap: MarketSnapshot): KFearResult {
  const h = snap.history;
  const liq = h.forcedLiqRatio ?? [];
  const amt = h.forcedLiqAmount ?? []; // v4: 반대매매 절대금액(F2·S2). 없으면 buildMarket이 비중 폴백.
  const bk = buildMarket(h.kospiClose ?? [], h.creditKospi ?? [], liq, amt);
  const bq = buildMarket(h.kosdaqClose ?? [], h.creditKosdaq ?? [], liq, amt);

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
    sizing: computeSizing(pk.grade, bk.creditDd, bk.dispDev, false), // 코스피는 단독 개념 없음(기준 시장)
  };
  const kosdaq: MarketFear = {
    market: "코스닥",
    ...bq,
    grade: pq.grade,
    size: pq.size,
    sizing: computeSizing(pq.grade, bq.creditDd, bq.dispDev, kosdaqRegime === "KOSDAQ_ONLY"), // 단독(미동반)=0%
    regime: kosdaqRegime,
    signaling: kosdaqSignaling,
  };
  return { kospi, kosdaq, kospiAccompanies };
}
