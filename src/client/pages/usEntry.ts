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

// ── VVIX 단기 반등 확인 (보조 신호) — 아래 상수/타입/함수는 기존 신호와 완전히 분리돼 있다 ──
// fired·tier·state·sizing 어디에도 들어가지 않는다. "얼마나 살 것인가"는 Tier가 정하고,
// 이 신호는 "공포가 진정되기 시작했는가"만 관찰한다.
/** VVIX 공포 극단 임계(절대값). 표본 내에서 선택된 값 — 표본 외 검증 전까지 동결. */
const VVIX_PANIC = 140;
/** 극단 탐색 창(거래일, 기준일 포함). */
const VVIX_LOOKBACK_TD = 3;
/** 데이터 구멍 방어: lookback 창의 행이 기준일로부터 이 달력일을 넘으면 '최근'으로 안 친다.
 *  (수집 실패 시 carryForwardEmpty가 묵은 시리즈를 되살리므로 행 인덱스만으론 부족하다.) */
const VVIX_LOOKBACK_CAL_DAYS = 10;
/** VVIX 기준일이 VIX 최신일보다 이 거래일 넘게 뒤처지면 stale → UNAVAILABLE. */
const VVIX_STALE_TD = 3;

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
export const dayKey = (t: number): number => Math.floor(t / DAY);

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

// ══════════════════════════════════════════════════════════════════════════════
// VVIX 단기 반등 확인 (보조 신호) — 기존 Tier/fired/state/sizing과 완전 분리
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 신호: **최근 3거래일 중 VVIX 종가 ≥ 140** AND **오늘 VIX 종가 < 직전 거래일 VIX 종가**.
 * 옵션 변동성 공포가 극단에 갔다가 VIX가 진정되기 시작하는 시점을 잡아, 향후 1주~1개월
 * 단기 반등 가능성을 관찰한다. **진입 규모(Tier)와 무관** — 티어를 올리지도 내리지도 않는다.
 *
 * ⚠️ `computeUsEntry` **밖의 독립 함수**인 이유: computeUsEntry는 VIX3M이 비면 아무 계산 전에
 * `return EMPTY`한다. 안에 넣으면 VIX3M 하나가 죽을 때 VVIX 카드까지 영구 UNAVAILABLE이 돼
 * "VVIX 실패만 격리한다"는 요구를 스스로 어긴다. 또 EMPTY는 모듈 공유 객체라 mutate 금지.
 *
 * 판정 행 배열 = **VVIX ∩ VIX 를 UTC dayKey 정확 일치로 조인**(ffill 금지, VIX3M/TERM과 독립).
 * 교집합을 쓰는 이유는 실측 근거가 있다: TVC:VIX에는 5년간 미국 휴장일 유령봉이 22개 있고
 * 값이 전일과 달라, raw VIX로 cooling을 재면 증시가 닫힌 날 하락으로 잡힌다. VVIX(CBOE)는
 * 실거래일만 있어 교집합이 곧 실제 거래일 캘린더가 된다(실측: TERM 타임라인 1254/1254 = 100% 커버).
 */
export type ReboundStatus = "UNAVAILABLE" | "IDLE" | "PANIC" | "CONFIRMED";

export const REBOUND_LABEL: Record<ReboundStatus, string> = {
  UNAVAILABLE: "VVIX 데이터 없음",
  IDLE: "평시",
  PANIC: "VVIX 공포 극단 · VIX 진정 대기",
  CONFIRMED: "반등 조건 충족",
};

export interface VvixRebound {
  status: ReboundStatus;
  /** 판정 기준일(조인 배열 마지막 행) ms — 메인 TERM 기준일과 다를 수 있다. */
  asOf: number | null;
  vvix: number | null; // 오늘 VVIX 종가
  vvixRecentMax: number | null; // 최근 3거래일 최고 VVIX
  panicToday: boolean; // 오늘 VVIX ≥ 140
  panicRecent: boolean; // 최근 3거래일 중 하나라도 ≥ 140
  panicDate: number | null; // 그 중 가장 최근 거래일 ms
  vix: number | null; // 같은 행의 VIX 종가
  vixPrev: number | null; // 직전 거래일 VIX 종가
  vixChange1d: number | null; // 전일 대비 변화율(비율, 예 −0.081)
  cooling: boolean; // 오늘 VIX < 전일 VIX (엄격 비교, 동률 불인정)
  confirmed: boolean; // panicRecent && cooling
  /** 현재 CONFIRMED 런의 첫날 ms — 성과 통계가 '첫날 진입' 기준이라 표시 단위를 맞춘다. */
  episodeStart: number | null;
  /** 연속 CONFIRMED 일차(0 = 오늘 미충족). */
  days: number;
  /** VVIX 기준일이 VIX 최신일보다 뒤처진 거래일 수(0=최신). */
  staleTd: number | null;
  history: SeriesPoint[]; // VVIX 차트용
  confirmedDates: number[]; // CONFIRMED 발생일(차트 마커)
}

const EMPTY_REBOUND: VvixRebound = {
  status: "UNAVAILABLE",
  asOf: null,
  vvix: null,
  vvixRecentMax: null,
  panicToday: false,
  panicRecent: false,
  panicDate: null,
  vix: null,
  vixPrev: null,
  vixChange1d: null,
  cooling: false,
  confirmed: false,
  episodeStart: null,
  days: 0,
  staleTd: null,
  history: [],
  confirmedDates: [],
};

/**
 * 백테스트 성과 — **한 곳에만 정의**(UI 여러 곳에 중복 하드코딩 금지).
 * `fullSample`은 사용자 제출 백테스트(2007~, 앱 데이터로는 재현 불가 구간 포함),
 * `inWindow`는 앱이 실제 보유한 히스토리(≈5년)에서 **재현 검증된** 수치다. 둘을 병기해야
 * "화면이 보여주는 창"과 "인용한 성과"의 괴리가 감춰지지 않는다. 실측상 fullSample의
 * 최악값 4개는 전부 이 창(2021~)에서 나왔다 — 즉 좋은 성과는 대부분 창 밖에 있다.
 */
export interface BacktestRow {
  label: string;
  n: number;
  wins: number;
  mean: number;
  median: number;
  worst: number;
}
export const VVIX_REBOUND_BACKTEST: {
  fullSample: { period: string; rows: BacktestRow[] };
  inWindow: { period: string; rows: BacktestRow[] };
} = {
  fullSample: {
    period: "2007~2026 (사용자 백테스트)",
    rows: [
      { label: "1주", n: 14, wins: 11, mean: 2.21, median: 1.21, worst: -0.96 },
      { label: "1개월", n: 14, wins: 12, mean: 6.0, median: 3.92, worst: -1.73 },
      { label: "3개월", n: 14, wins: 11, mean: 10.82, median: 9.5, worst: -11.49 },
      { label: "6개월", n: 13, wins: 9, mean: 14.1, median: 13.76, worst: -22.8 },
    ],
  },
  inWindow: {
    period: "2021~2026 (앱 히스토리 창 · 재현 검증됨)",
    rows: [
      { label: "1주", n: 5, wins: 3, mean: 1.58, median: 0.96, worst: -0.96 },
      { label: "1개월", n: 5, wins: 4, mean: 3.47, median: 1.31, worst: -1.73 },
      { label: "3개월", n: 5, wins: 3, mean: 6.2, median: 13.14, worst: -11.49 },
      { label: "6개월", n: 4, wins: 2, mean: 5.77, median: 20.55, worst: -22.8 },
    ],
  },
};

/**
 * 창 안 검증 앵커 — 실데이터(CBOE:VVIX + TVC:VIX, 5년)에서 위 정의로 재현된 에피소드 첫날.
 * TIER0_ANCHORS와 같은 역할: **파이프라인이 조용히 틀어지는 것**(심볼 변경·dayKey 조인 어긋남·
 * 교집합 규칙 회귀)을 잡는다. ⚠️ 백테스트의 정당성을 증명하는 앵커가 아니라 — 우리 재현값이라
 * 순환이다 — 어디까지나 회귀 감지용이다. 창 밖(2007~2020) 9건은 히스토리 부족으로 검증 불가.
 */
export const VVIX_REBOUND_ANCHORS = ["2021-11-29", "2022-01-27", "2024-08-06", "2025-04-09", "2026-03-09"];

/** VVIX·VIX를 UTC 거래일로 정확 조인한 행(ffill 없음, 교집합). */
function reboundRows(snap: MarketSnapshot): Array<{ t: number; d: number; vvix: number; vix: number }> {
  const h = snap.history ?? ({} as MarketSnapshot["history"]);
  const vvixBy = new Map<number, number>();
  for (const p of h.vvix ?? []) if (Number.isFinite(p.v)) vvixBy.set(dayKey(p.t), p.v);
  const rows: Array<{ t: number; d: number; vvix: number; vix: number }> = [];
  for (const p of [...(h.vix ?? [])].sort((a, b) => a.t - b.t)) {
    if (!Number.isFinite(p.v)) continue;
    const d = dayKey(p.t);
    const vv = vvixBy.get(d);
    if (vv !== undefined) rows.push({ t: p.t, d, vvix: vv, vix: p.v });
  }
  return rows;
}

/** 어떤 인덱스 i에서의 CONFIRMED 여부(차트 마커·앵커 검증용). i≥1 필요. */
function confirmedAt(rows: ReturnType<typeof reboundRows>, i: number): boolean {
  if (i < 1) return false;
  if (!(rows[i].vix < rows[i - 1].vix)) return false; // 엄격 비교 — 동률은 진정 아님
  for (let j = Math.max(0, i - VVIX_LOOKBACK_TD + 1); j <= i; j++) {
    if (rows[i].d - rows[j].d > VVIX_LOOKBACK_CAL_DAYS) continue; // 데이터 구멍 방어
    if (rows[j].vvix >= VVIX_PANIC) return true;
  }
  return false;
}

export function computeVvixRebound(snap: MarketSnapshot): VvixRebound {
  const rows = reboundRows(snap);
  const history = rows.map((r) => ({ t: r.t, v: r.vvix }));
  if (rows.length < 2) return { ...EMPTY_REBOUND, history };

  const L = rows.length - 1;
  const cur = rows[L];
  const prev = rows[L - 1];

  // stale 방어: VVIX가 못 따라오면(수집 실패 후 carryForward 등) 옛 VVIX와 오늘 VIX를 짝지어
  // 잘못된 CONFIRMED가 뜬다. VIX 최신 거래일과 조인 기준일의 차이를 거래일로 센다.
  const vixDays = [...new Set((snap.history?.vix ?? []).filter((p) => Number.isFinite(p.v)).map((p) => dayKey(p.t)))].sort(
    (a, b) => a - b,
  );
  const staleTd = vixDays.length > 0 ? vixDays.filter((d) => d > cur.d).length : null;
  if (staleTd !== null && staleTd > VVIX_STALE_TD) return { ...EMPTY_REBOUND, history, asOf: cur.t, staleTd };

  // 최근 3거래일(기준일 포함) — 달력 상한 안의 행만 '최근'으로 인정.
  const win = rows.slice(Math.max(0, L - VVIX_LOOKBACK_TD + 1)).filter((r) => cur.d - r.d <= VVIX_LOOKBACK_CAL_DAYS);
  const vvixRecentMax = win.length > 0 ? Math.max(...win.map((r) => r.vvix)) : null;
  const panicRows = win.filter((r) => r.vvix >= VVIX_PANIC);
  const panicRecent = panicRows.length > 0;
  const panicDate = panicRecent ? panicRows[panicRows.length - 1].t : null;
  const panicToday = cur.vvix >= VVIX_PANIC;

  const cooling = cur.vix < prev.vix; // 엄격 `<` — 동률은 진정 확인으로 인정하지 않는다
  const vixChange1d = prev.vix > 0 ? cur.vix / prev.vix - 1 : null;
  const confirmed = panicRecent && cooling;

  // 연속 CONFIRMED 런(에피소드 첫날) — 성과 통계가 '에피소드 첫날 진입' 기준이라 표시를 맞춘다.
  let days = 0;
  let episodeStart: number | null = null;
  if (confirmed) {
    let i = L;
    while (i >= 1 && confirmedAt(rows, i)) {
      days++;
      episodeStart = rows[i].t;
      i--;
    }
  }

  const confirmedDates: number[] = [];
  for (let i = 1; i < rows.length; i++) if (confirmedAt(rows, i)) confirmedDates.push(rows[i].t);

  const status: ReboundStatus = confirmed ? "CONFIRMED" : panicRecent ? "PANIC" : "IDLE";
  return {
    status,
    asOf: cur.t,
    vvix: cur.vvix,
    vvixRecentMax,
    panicToday,
    panicRecent,
    panicDate,
    vix: cur.vix,
    vixPrev: prev.vix,
    vixChange1d,
    cooling,
    confirmed,
    episodeStart,
    days,
    staleTd,
    history,
    confirmedDates,
  };
}

/** VVIX_REBOUND_ANCHORS가 실데이터에서 재현되는지(리콜) — verifyTier0Anchors와 동형. */
export function verifyVvixAnchors(snap: MarketSnapshot, tolDays = 2): Tier0Verify {
  const rows = reboundRows(snap);
  const onByDay = new Map<number, boolean>();
  for (let i = 1; i < rows.length; i++) onByDay.set(rows[i].d, confirmedAt(rows, i));
  const days = [...onByDay.keys()].sort((a, b) => a - b);
  const misses: string[] = [];
  const outOfWindow: string[] = [];
  let hit = 0;
  let inWindow = 0;
  for (const s of VVIX_REBOUND_ANCHORS) {
    const parsed = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(parsed) || days.length === 0 || dayKey(parsed) < days[0] || dayKey(parsed) > days[days.length - 1]) {
      outOfWindow.push(s);
      continue;
    }
    inWindow++;
    const d = dayKey(parsed);
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

export const __test = {
  computeUsEntry,
  dayKey,
  asOf,
  computeTier0,
  verifyTier0Anchors,
  rollMax,
  rollMean,
  computeVvixRebound,
  verifyVvixAnchors,
  reboundRows,
  confirmedAt,
  VVIX_PANIC,
  VVIX_LOOKBACK_TD,
  VVIX_LOOKBACK_CAL_DAYS,
  VVIX_STALE_TD,
};
