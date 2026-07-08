import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * 데이터 정합성 앵커 — 실제 KOFIA 화면 / KRX에서 확인한 고정 기준값.
 *
 * 파싱·단위·심볼이 조용히 바뀌면 아래 값에서 어긋난다. 그럼 모든 하류 신호가
 * 무의미해지므로 두 겹으로 막는다:
 *  1) assertAnchor / assertAnchorSum — 각 수집기가 자기 시리즈를 검문, 불일치 시
 *     **throw**해서 그 소스를 통째 거부(빈 시리즈 → 화면엔 '수집 실패'만, 이상값 X).
 *  2) checkAnchors — 스냅샷 레벨 소프트 경고(staleness 등) errors[]로 노출.
 *
 * 날짜 매칭은 **밀리초 허용오차(tolMs)**로 한다: KOFIA는 정확한 Date.UTC(자정)이라
 * tolMs=0(정확 일치)로, 지수(TradingView)는 바 타임스탬프가 tz로 몇 시간 밀릴 수
 * 있어 tolMs=TZ_TOL_MS(20h)로 — 같은 세션 봉(≤15h 오프셋)은 매칭하되 **인접 거래일
 * (≥24h)은 절대 안 잡는다**(그래야 앵커일 봉이 아직 없을 때 옆날 봉을 잘못 잡아
 * false-throw하는 사고를 막음).
 */

const DAY = 86400000;
/** 지수 앵커 tz 허용(20h): 같은 세션 봉만 잡고 인접 거래일(≥24h)은 배제. */
export const TZ_TOL_MS = 20 * 3600000;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (t: number) => {
  const dd = new Date(t);
  return `${dd.getUTCFullYear()}-${pad(dd.getUTCMonth() + 1)}-${pad(dd.getUTCDate())}`;
};

/** 대상일 ±tolMs 안에서 target에 가장 가까운 점의 값(없으면 null). */
function valueOn(series: SeriesPoint[], y: number, m: number, d: number, tolMs: number): number | null {
  const target = Date.UTC(y, m - 1, d);
  let best: { dt: number; v: number } | null = null;
  for (const p of series) {
    const dt = Math.abs(p.t - target);
    if (dt <= tolMs && (!best || dt < best.dt)) best = { dt, v: p.v };
  }
  return best ? best.v : null;
}

/** 대상일 ±tolMs 안에 expected(±tol)에 맞는 점이 하나라도 있는가.
 *  true=통과, false=그 날짜대는 있으나 값이 다 틀림, null=그 날짜 자체가 없음(검증불가). */
function anyNear(series: SeriesPoint[], y: number, m: number, d: number, expected: number, tol: number, tolMs: number): boolean | null {
  const target = Date.UTC(y, m - 1, d);
  let sawDate = false;
  for (const p of series) {
    if (Math.abs(p.t - target) <= tolMs) {
      sawDate = true;
      if (Math.abs(p.v - expected) <= tol) return true;
    }
  }
  return sawDate ? false : null;
}

/**
 * HARD 앵커 검문소 — 앵커 날짜가 데이터에 **있는데** 값이 어긋나면 throw.
 * 날짜가 아직 없거나(오늘/미래·휴장) 시리즈가 비었으면 no-op(검증 불가 시 통과 —
 * 오탐 방지). "×8 배수 변경·TMPV 컬럼 이동·심볼 변경"을 화면에 뜨기 전에 차단.
 */
export function assertAnchor(
  series: SeriesPoint[],
  y: number,
  m: number,
  d: number,
  expected: number,
  tol: number,
  tolMs: number,
  label: string,
): void {
  if (!series || series.length === 0) return;
  const ok = anyNear(series, y, m, d, expected, tol, tolMs);
  if (ok === false) {
    const v = valueOn(series, y, m, d, tolMs);
    throw new Error(
      `앵커 불일치 [${label}] ${y}-${pad(m)}-${pad(d)}: 계산 ${v?.toFixed(3) ?? "?"} vs 기준 ${expected}` +
        ` — 파싱/단위/심볼 변경으로 데이터 신뢰 불가 → 저장 거부`,
    );
  }
}

/** 두 시리즈 합의 앵커(예: 유가+코스닥 = 신용융자 전체). 둘 다 그 날짜가 있고 합이
 *  어긋나면 throw — 한 컬럼만 스케일이 틀어지는(예: 코스닥만 ×1) 사고를 잡는다. */
export function assertAnchorSum(
  a: SeriesPoint[],
  b: SeriesPoint[],
  y: number,
  m: number,
  d: number,
  expected: number,
  tol: number,
  tolMs: number,
  label: string,
): void {
  if (!a?.length || !b?.length) return;
  const va = valueOn(a, y, m, d, tolMs);
  const vb = valueOn(b, y, m, d, tolMs);
  if (va === null || vb === null) return;
  if (Math.abs(va + vb - expected) > tol) {
    throw new Error(
      `앵커 불일치 [${label}] ${y}-${pad(m)}-${pad(d)}: 계산 ${(va + vb).toFixed(3)} vs 기준 ${expected}` +
        ` — 컬럼별 단위/스케일 불일치 의심 → 저장 거부`,
    );
  }
}

/** 소프트 버전: 앵커 날짜가 있는데 값이 틀리면 true(throw 대신 호출부가 그 시리즈만
 *  드롭할 때 씀 — 예: 코스닥만 이상하면 코스피는 살림). 날짜 없거나 빈 시리즈면 false. */
export function anchorViolated(series: SeriesPoint[], y: number, m: number, d: number, expected: number, tol: number, tolMs: number): boolean {
  if (!series || series.length === 0) return false;
  return anyNear(series, y, m, d, expected, tol, tolMs) === false;
}

interface AnchorSpec {
  label: string;
  y: number;
  m: number;
  d: number;
  expected: number;
  tol: number;
  tolMs: number;
  series: (h: MarketSnapshot["history"]) => SeriesPoint[] | undefined;
}

/** 소프트 경고용(2차 방어). 1차 hard assert가 이미 거른 뒤라 대부분 통과하지만,
 *  staleness처럼 수집기 단독으로 못 보는 것과 belt-and-suspenders용. */
const ANCHORS: AnchorSpec[] = [
  { label: "신용융자 유가(조)", y: 2026, m: 7, d: 7, expected: 29.074973, tol: 0.05, tolMs: 0, series: (h) => h.creditKospi },
  { label: "신용융자 코스닥(조)", y: 2026, m: 7, d: 7, expected: 7.990423, tol: 0.05, tolMs: 0, series: (h) => h.creditKosdaq },
  { label: "반대매매 비중(%)", y: 2026, m: 7, d: 7, expected: 2.2, tol: 0.2, tolMs: 0, series: (h) => h.forcedLiqRatio },
  { label: "반대매매 비중(%)", y: 2026, m: 6, d: 24, expected: 7.5, tol: 0.4, tolMs: 0, series: (h) => h.forcedLiqRatio },
  { label: "코스피 종가", y: 2026, m: 6, d: 23, expected: 8203.84, tol: 45, tolMs: TZ_TOL_MS, series: (h) => h.kospiClose },
  { label: "코스피 종가", y: 2026, m: 7, d: 8, expected: 7246.79, tol: 45, tolMs: TZ_TOL_MS, series: (h) => h.kospiClose },
];

/** 앵커 대조 + 지수 staleness. 경고 문자열 배열 반환(빈 배열 = 정상). */
export function checkAnchors(snap: MarketSnapshot): string[] {
  const h = snap.history;
  const warns: string[] = [];

  const evaluated = new Set<SeriesPoint[]>();
  for (const a of ANCHORS) {
    const s = a.series(h);
    if (!s || s.length === 0) continue;
    const v = valueOn(s, a.y, a.m, a.d, a.tolMs);
    if (v === null) continue;
    evaluated.add(s);
    if (Math.abs(v - a.expected) > a.tol) {
      warns.push(`⚠️ 앵커 불일치 [${a.label}] ${a.y}-${pad(a.m)}-${pad(a.d)}: 계산 ${v.toFixed(3)} vs 기준 ${a.expected} — 파싱/단위/심볼 변경 의심`);
    }
  }
  // 앵커 기준일이 모두 데이터 창 밖(먼 미래에 밀려남)이면 검증 자체가 무력 — "있는데 못
  // 잰 것"과 "전부 정상"을 구별해 알림(새 앵커 필요 신호). throw는 아님(정상 노후화).
  for (const [name, s] of [
    ["신용융자", h.creditKospi],
    ["반대매매", h.forcedLiqRatio],
    ["코스피 종가", h.kospiClose],
  ] as const) {
    if (s && s.length > 0 && !evaluated.has(s)) {
      warns.push(`ℹ️ [${name}] 앵커 기준일이 모두 데이터 창 밖 — 정합성 검증 불가(새 앵커 추가 필요)`);
    }
  }

  // 신용융자 전체(유가+코스닥) 2026-06-24 = 38.632824 조
  if (h.creditKospi?.length && h.creditKosdaq?.length) {
    const a = valueOn(h.creditKospi, 2026, 6, 24, 0);
    const b = valueOn(h.creditKosdaq, 2026, 6, 24, 0);
    if (a !== null && b !== null && Math.abs(a + b - 38.632824) > 0.1) {
      warns.push(`⚠️ 앵커 불일치 [신용융자 전체(조)] 2026-06-24: 계산 ${(a + b).toFixed(3)} vs 기준 38.633 — 단위(×8) 의심`);
    }
  }

  // 지수(TV)는 실시간, KOFIA는 T+1 → 지수가 2일 넘게 뒤처지면 WS 멈춤 의심.
  const idxLast = h.kospiClose?.at(-1)?.t;
  const kofiaLast = h.forcedLiqRatio?.at(-1)?.t;
  if (idxLast && kofiaLast && idxLast < kofiaLast - 2 * DAY) {
    warns.push(`⚠️ 코스피 종가가 반대매매(KOFIA)보다 오래됨 — TradingView 지연/끊김 의심 (지수 마지막 ${isoDay(idxLast)}, KOFIA ${isoDay(kofiaLast)})`);
  }

  return warns;
}
