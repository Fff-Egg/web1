import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * US 진입신호 실행기 — 나스닥 진입신호를 절대값 2트랙으로 계산한다(지시서 v1.0).
 *
 *   TERM = VIX 종가 / VIX3M 종가 (같은 거래일)
 *   A(주 진입)  : TERM ≥ 1.05
 *   B(강 신호)  : TERM ≥ 1.00 AND HY OAS ≥ 4.5%   (HY는 T+1 → 판정에 D-1 관측치 shift(1))
 *   MEGA 배지   : VIX ≥ 40
 *   A∪B 충족 = 진입권(FIRED). A&&B = FIRED_AB(최상급).
 *
 * 상태머신: IDLE / WATCH(TERM≥0.95 or HY≥4.25) / ARMED(TERM≥1.00) /
 *           ACTIVE_A|B|AB(조건 충족 중 매일 유지) / POST(조건 소멸 후 21거래일 참고창).
 *
 * 신호 상태(레이어1)는 매일 재평가·쿨다운 없음 — 조건 지속 중이면 "연속 N일차"로 계속 표시해
 * 첫날을 놓쳐도 추격 진입을 판단할 수 있게 한다. 에피소드(레이어2)는 21거래일 병합으로
 * 통계·직전 발동 표시에만 쓰고 매수 억제엔 쓰지 않는다.
 *
 * K-공포지수와 동일하게 **전부 클라 계산**(저장된 히스토리 입력, 추가 LLM 없음).
 */

const DAY = 86400000;
const TERM_A = 1.05; // Track A 트리거
const TERM_ARMED = 1.0; // 역전 시작(B 판정 대기)
const TERM_WATCH = 0.95; // 접근 경보
const HY_B = 4.5; // Track B 신용확인
const HY_WATCH = 4.25;
const VIX_MEGA = 40; // 초대형 패닉 배지
const MERGE_TD = 21; // 에피소드 병합 창(거래일)
// Tier 0(조정 매수): 나스닥 고점대비 −8% & 200일선 위. "자기 추세 대비 위치"라는
// 자기정규화 필터(TERM이 비율이라 살아난 것과 같은 계열) — 강세장 조정은 −8%에도
// 200일선 위지만, 하락장은 −8% 시점에 이미 200일선 아래라 자동으로 꺼진다.
const DD_TIER0 = -0.08; // 고점대비 −8%
const HIGH_WIN = 252; // 고점(52주) 롤링 창
const SMA_TREND = 200; // 추세 필터(200일선)

/**
 * Tier 0 검증 앵커 — 백테스트가 잡은 13개 조정 매수 발동일(에피소드 첫날). 52주 롤링
 * 정의가 맞으면 `verifyTier0Anchors`가 히스토리 범위 내 앵커를 전부 재현해야 한다.
 * 리트머스: 2023-05-03·2023-09-26이 재현되면 롤링(rollMax 252) 정의 정상.
 * 성과(n=13): 6달 +21.1%, 승률 100%, 최악 +5.4%, 2022년 0건.
 * ※ 히스토리 창(≈5년)보다 오래된 앵커(2020~2021)는 '창 밖'으로 제외 표기한다.
 */
export const TIER0_ANCHORS = [
  "2020-02-25", "2020-04-14", "2020-09-08", "2020-10-28",
  "2021-03-04", "2023-01-27", "2023-03-02", "2023-05-03",
  "2023-09-26", "2023-10-31", "2024-07-30", "2024-09-03",
  "2025-02-27",
];

export type UsState = "IDLE" | "WATCH" | "ARMED" | "ACTIVE_A" | "ACTIVE_B" | "ACTIVE_AB" | "POST";

/** 현재 활성 티어: 0 조정매수(예비대 선발대) / 1 주 신호(본대) / 2 확인 상향(최대) / null 없음. */
export type Tier = 0 | 1 | 2 | null;

export const STATE_LABEL: Record<UsState, string> = {
  IDLE: "평시",
  WATCH: "접근 경보",
  ARMED: "역전 시작",
  ACTIVE_A: "진입 A",
  ACTIVE_B: "진입 B(강)",
  ACTIVE_AB: "진입 AB(최상급)",
  POST: "발동 직후",
};

export interface UsEpisode {
  t: number; // 발동일(에피소드 앵커) ms
  track: "A" | "B" | "AB";
  agoTradingDays: number; // 앵커→기준일 거래일 경과
}

export interface UsEntry {
  hasData: boolean;
  asOf: number | null; // 판정 기준일(TERM 최신 거래일) ms
  hyAsOf: number | null; // 사용된 HY 관측 기준일(D-1) ms
  term: number | null;
  hy: number | null; // shift(1) 적용된 HY OAS
  vix: number | null;
  trackA: boolean;
  trackB: boolean;
  mega: boolean;
  state: UsState;
  activeDays: number; // 연속 N일차(0=비활성)
  firstFired: number | null; // 현재 에피소드 첫 발동일 ms
  nasdaqSince: number | null; // 첫 발동가 대비 현재 나스닥 등락률(%)
  prevEpisode: UsEpisode | null; // 직전(현재 아닌) 에피소드
  // Tier 0(조정 매수) — 나스닥 IXIC 기반, TERM/HY와 독립.
  dd: number | null; // 나스닥 고점(52주)대비 낙폭(음수, 예: −0.093)
  above200: boolean; // 200일선 위 여부(추세 필터)
  tier0: boolean; // DD≤−8% & 200일선 위
  tier: Tier; // 현재 활성 티어(0/1/2/null)
  termHistory: SeriesPoint[]; // TERM 추이 차트
  hyHistory: SeriesPoint[]; // HY OAS 추이 차트
  ddHistory: SeriesPoint[]; // 나스닥 고점대비 낙폭(%) 추이
}

const EMPTY: UsEntry = {
  hasData: false,
  asOf: null,
  hyAsOf: null,
  term: null,
  hy: null,
  vix: null,
  trackA: false,
  trackB: false,
  mega: false,
  state: "IDLE",
  activeDays: 0,
  firstFired: null,
  nasdaqSince: null,
  prevEpisode: null,
  dd: null,
  above200: false,
  tier0: false,
  tier: null,
  termHistory: [],
  hyHistory: [],
  ddHistory: [],
};

/** 롤링 최대(min_periods=win): 창이 다 안 차면 NaN. */
function rollMax(arr: number[], win: number): number[] {
  const out = new Array<number>(arr.length).fill(NaN);
  for (let i = win - 1; i < arr.length; i++) {
    let m = -Infinity;
    let ok = true;
    for (let j = i - win + 1; j <= i; j++) {
      if (!Number.isFinite(arr[j])) {
        ok = false;
        break;
      }
      if (arr[j] > m) m = arr[j];
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** 롤링 평균(min_periods=win). */
function rollMean(arr: number[], win: number): number[] {
  const out = new Array<number>(arr.length).fill(NaN);
  for (let i = win - 1; i < arr.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - win + 1; j <= i; j++) {
      if (!Number.isFinite(arr[j])) {
        ok = false;
        break;
      }
      s += arr[j];
    }
    if (ok) out[i] = s / win;
  }
  return out;
}

/** UTC 거래일 키(US 시계열은 UTC 자정 기준 일봉이라 일 단위로 내려 정렬). */
const dayKey = (t: number): number => Math.floor(t / DAY);

/** ts 이하(포함) 가장 최근 값 — 정렬된 [day, value] 목록에서 as-of ffill. null=이전 없음. */
function asOf(sorted: Array<{ d: number; v: number }>, d: number): number | null {
  let v: number | null = null;
  for (const p of sorted) {
    if (p.d > d) break;
    v = p.v;
  }
  return v;
}

/**
 * Tier 0(조정 매수) 계산 — 나스닥 IXIC 고점(52주 롤링)대비 −8% & 200일선 위. 최신값
 * (dd/above200/tier0)과 차트용 낙폭 히스토리, 그리고 일별 on/off 맵(앵커 검증용)을 낸다.
 */
function computeTier0(ixicPts: SeriesPoint[]): {
  dd: number | null;
  above200: boolean;
  tier0: boolean;
  ddHistory: SeriesPoint[];
  onByDay: Map<number, boolean>;
} {
  const ix = [...ixicPts].filter((p) => Number.isFinite(p.v) && p.v > 0).sort((a, b) => a.t - b.t);
  const ddHistory: SeriesPoint[] = [];
  const onByDay = new Map<number, boolean>();
  let dd: number | null = null;
  let above200 = false;
  let tier0 = false;
  if (ix.length > SMA_TREND) {
    const closes = ix.map((p) => p.v);
    const high = rollMax(closes, HIGH_WIN);
    const sma = rollMean(closes, SMA_TREND);
    for (let i = 0; i < closes.length; i++) {
      if (!Number.isFinite(high[i]) || !Number.isFinite(sma[i]) || high[i] <= 0) continue;
      const d = closes[i] / high[i] - 1;
      ddHistory.push({ t: ix[i].t, v: Math.round(d * 1000) / 10 }); // %
      onByDay.set(dayKey(ix[i].t), d <= DD_TIER0 && closes[i] > sma[i]);
    }
    const j = closes.length - 1;
    if (Number.isFinite(high[j]) && high[j] > 0) dd = closes[j] / high[j] - 1;
    if (Number.isFinite(sma[j])) above200 = closes[j] > sma[j];
    tier0 = dd !== null && dd <= DD_TIER0 && above200;
  }
  return { dd, above200, tier0, ddHistory, onByDay };
}

export interface Tier0Verify {
  hit: number; // 재현된 앵커 수
  inWindow: number; // 히스토리 창 안(검증 가능) 앵커 수
  misses: string[]; // 창 안인데 재현 안 된 앵커
  outOfWindow: string[]; // 창 밖(오래돼 계산 불가) 앵커
}

/**
 * TIER0_ANCHORS가 실제 나스닥 히스토리에서 재현되는지 검증(리콜). 앵커일 ±tolDays
 * 거래일 안에 tier0가 켜졌으면 재현. 계산 가능 범위(min..max onByDay 날짜) 밖 앵커는
 * '창 밖'으로 분리. 리트머스(2023-05-03·2023-09-26) 재현이 롤링 정의 정상 판정.
 */
export function verifyTier0Anchors(snap: MarketSnapshot, tolDays = 2): Tier0Verify {
  const { onByDay } = computeTier0(snap.history?.ixic ?? []);
  const days = [...onByDay.keys()].sort((a, b) => a - b);
  const misses: string[] = [];
  const outOfWindow: string[] = [];
  let hit = 0;
  let inWindow = 0;
  const minD = days[0];
  const maxD = days[days.length - 1];
  for (const s of TIER0_ANCHORS) {
    const parsed = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(parsed) || days.length === 0) {
      outOfWindow.push(s);
      continue;
    }
    const d = dayKey(parsed);
    if (d < minD || d > maxD) {
      outOfWindow.push(s);
      continue;
    }
    inWindow++;
    let fired = false;
    for (let k = -tolDays; k <= tolDays; k++) {
      if (onByDay.get(d + k)) {
        fired = true;
        break;
      }
    }
    if (fired) hit++;
    else misses.push(s);
  }
  return { hit, inWindow, misses, outOfWindow };
}

export function computeUsEntry(snap: MarketSnapshot): UsEntry {
  const h = snap.history ?? ({} as MarketSnapshot["history"]);
  const vixPts = h.vix ?? [];
  const vix3mPts = h.vix3m ?? [];
  const hyPts = h.hyOas ?? [];
  const ixicPts = h.ixic ?? [];
  if (vixPts.length === 0 || vix3mPts.length === 0) return EMPTY;

  // VIX3M을 거래일로 색인 → TERM 타임라인 = VIX·VIX3M 둘 다 있는 날.
  const v3ByDay = new Map<number, number>();
  for (const p of vix3mPts) if (p.v > 0) v3ByDay.set(dayKey(p.t), p.v);
  const tl: Array<{ t: number; d: number; term: number; vix: number }> = [];
  for (const p of [...vixPts].sort((a, b) => a.t - b.t)) {
    const v3 = v3ByDay.get(dayKey(p.t));
    if (v3 !== undefined && v3 > 0 && Number.isFinite(p.v)) {
      tl.push({ t: p.t, d: dayKey(p.t), term: p.v / v3, vix: p.v });
    }
  }
  if (tl.length === 0) return EMPTY;

  const hySorted = [...hyPts]
    .filter((p) => Number.isFinite(p.v))
    .map((p) => ({ d: dayKey(p.t), v: p.v, t: p.t }))
    .sort((a, b) => a.d - b.d);
  const ixicSorted = [...ixicPts]
    .filter((p) => Number.isFinite(p.v))
    .map((p) => ({ d: dayKey(p.t), v: p.v }))
    .sort((a, b) => a.d - b.d);

  // HY: 거래일 캘린더(TERM 타임라인)에 ffill 후 shift(1) — D일 판정엔 D-1 관측치.
  const n = tl.length;
  const hyOnCal = tl.map((row) => asOf(hySorted, row.d)); // reindex+ffill
  const hyShift = new Array<number | null>(n).fill(null);
  for (let i = 1; i < n; i++) hyShift[i] = hyOnCal[i - 1];
  // 사용한 HY 관측일(D-1의 실제 관측 날짜) — 화면 "HY기준일" 표기용.
  const hyObsDayAt = (i: number): number | null => {
    if (i < 1) return null;
    const dPrev = tl[i - 1].d;
    let day: number | null = null;
    for (const p of hySorted) {
      if (p.d > dPrev) break;
      day = p.d;
    }
    return day;
  };

  // 트랙·발동 배열.
  const A = new Array<boolean>(n);
  const B = new Array<boolean>(n);
  const fired = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    A[i] = tl[i].term >= TERM_A;
    const hv = hyShift[i];
    B[i] = tl[i].term >= TERM_ARMED && hv !== null && hv >= HY_B;
    fired[i] = A[i] || B[i];
  }

  // 에피소드(21거래일 병합): 연속/근접(gap≤21) 발동을 한 에피소드로. 앵커=첫 발동 인덱스.
  const episodes: Array<{ anchor: number; last: number }> = [];
  for (let i = 0; i < n; i++) {
    if (!fired[i]) continue;
    const cur = episodes[episodes.length - 1];
    if (cur && i - cur.last <= MERGE_TD) cur.last = i;
    else episodes.push({ anchor: i, last: i });
  }
  const trackOf = (i: number): "A" | "B" | "AB" => (A[i] && B[i] ? "AB" : A[i] ? "A" : "B");

  const L = n - 1;
  const cur = tl[L];
  const megaNow = cur.vix >= VIX_MEGA;

  // 상태(우선순위 ACTIVE > ARMED > WATCH > POST > IDLE).
  let state: UsState;
  if (fired[L]) state = A[L] && B[L] ? "ACTIVE_AB" : A[L] ? "ACTIVE_A" : "ACTIVE_B";
  else if (cur.term >= TERM_ARMED) state = "ARMED";
  else if (cur.term >= TERM_WATCH || (hyShift[L] !== null && hyShift[L]! >= HY_WATCH)) state = "WATCH";
  else {
    const lastFired = fired.lastIndexOf(true);
    state = lastFired >= 0 && L - lastFired <= MERGE_TD ? "POST" : "IDLE";
  }

  // 연속 N일차 = 오늘 끝나는 연속 발동 런.
  let activeDays = 0;
  if (fired[L]) {
    let i = L;
    while (i >= 0 && fired[i]) {
      activeDays++;
      i--;
    }
  }

  // 현재 에피소드(오늘 발동 중이면 그 에피소드) 앵커 = 첫 발동일. 나스닥 등락률 기준.
  const curEpiIdx = fired[L] ? episodes.length - 1 : -1;
  const curEpi = curEpiIdx >= 0 ? episodes[curEpiIdx] : null;
  const firstFired = curEpi ? tl[curEpi.anchor].t : null;
  let nasdaqSince: number | null = null;
  if (curEpi) {
    const base = asOf(ixicSorted, tl[curEpi.anchor].d);
    const now = asOf(ixicSorted, cur.d);
    if (base !== null && now !== null && base > 0) nasdaqSince = ((now - base) / base) * 100;
  }

  // 직전 에피소드 = 현재가 아닌 가장 최근 에피소드.
  const prevIdx = fired[L] ? curEpiIdx - 1 : episodes.length - 1;
  const prevEpisode: UsEpisode | null =
    prevIdx >= 0
      ? { t: tl[episodes[prevIdx].anchor].t, track: trackOf(episodes[prevIdx].anchor), agoTradingDays: L - episodes[prevIdx].anchor }
      : null;

  // ── Tier 0 (조정 매수): 나스닥 IXIC 고점대비 −8% & 200일선 위 ──
  const { dd, above200, tier0, ddHistory } = computeTier0(ixicPts);

  // 활성 티어: 2 확인상향(AB or MEGA) / 1 주신호(A or B) / 0 조정매수 / null.
  let tier: Tier = null;
  if (fired[L]) tier = (A[L] && B[L]) || megaNow ? 2 : 1;
  else if (tier0) tier = 0;

  const termHistory = tl.map((r) => ({ t: r.t, v: Math.round(r.term * 1000) / 1000 }));
  const hyHistory = hySorted.map((p) => ({ t: p.t, v: p.v }));

  return {
    hasData: true,
    asOf: cur.t,
    hyAsOf: hyObsDayAt(L) !== null ? hyObsDayAt(L)! * DAY : null,
    term: cur.term,
    hy: hyShift[L],
    vix: cur.vix,
    trackA: A[L],
    trackB: B[L],
    mega: megaNow,
    state,
    activeDays,
    firstFired,
    nasdaqSince,
    prevEpisode,
    dd,
    above200,
    tier0,
    tier,
    termHistory,
    hyHistory,
    ddHistory,
  };
}

export const __test = { computeUsEntry, dayKey, asOf, computeTier0, verifyTier0Anchors, rollMax, rollMean };
