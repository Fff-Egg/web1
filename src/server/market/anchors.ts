import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * 데이터 정합성 앵커 — 실제 KOFIA 화면 / KRX에서 확인한 고정 기준값.
 *
 * 파싱·단위·심볼이 조용히 바뀌면 아래 값에서 어긋난다. 그럼 모든 하류 신호가
 * 무의미해지므로, 스냅샷 수집 때마다 대조해 **불일치 시 시끄럽게 경고**한다
 * (throw가 아니라 errors[]로 노출 — 한 앵커가 틀려도 나머지는 보되, 사용자가 즉시
 * 인지하도록). 날짜는 KST 달력일. 시리즈 t는 KOFIA=Date.UTC(자정), 지수=바 ms.
 */

interface AnchorSpec {
  label: string;
  y: number;
  m: number;
  d: number;
  expected: number;
  tol: number; // 시리즈 단위 절대 허용오차
  tolDays: number; // 날짜 매칭 허용(지수는 tz 오차 대비 ±1)
  series: (h: MarketSnapshot["history"]) => SeriesPoint[] | undefined;
}

/** 유가+코스닥 신용융자 전체는 별도 취급(두 시리즈 합산). */
const ANCHORS: AnchorSpec[] = [
  { label: "신용융자 유가(조)", y: 2026, m: 7, d: 7, expected: 29.074973, tol: 0.05, tolDays: 0, series: (h) => h.creditKospi },
  { label: "반대매매 비중(%)", y: 2026, m: 7, d: 7, expected: 2.2, tol: 0.2, tolDays: 0, series: (h) => h.forcedLiqRatio },
  { label: "반대매매 비중(%)", y: 2026, m: 6, d: 24, expected: 7.5, tol: 0.4, tolDays: 0, series: (h) => h.forcedLiqRatio },
  { label: "코스피 종가", y: 2026, m: 6, d: 23, expected: 8203.84, tol: 45, tolDays: 1, series: (h) => h.kospiClose },
  { label: "코스피 종가", y: 2026, m: 7, d: 8, expected: 7246.79, tol: 45, tolDays: 1, series: (h) => h.kospiClose },
];

const DAY = 86400000;

/** 대상 달력일(±tolDays) 중 가장 가까운 점의 값. 없으면 null(아직 수집 안 됨). */
function valueOn(series: SeriesPoint[], y: number, m: number, d: number, tolDays: number): number | null {
  const target = Date.UTC(y, m - 1, d);
  let best: { dt: number; v: number } | null = null;
  for (const p of series) {
    const dt = Math.abs(p.t - target);
    if (dt <= tolDays * DAY && (!best || dt < best.dt)) best = { dt, v: p.v };
  }
  return best ? best.v : null;
}

/** 대상 달력일(±tolDays) 안에 expected(±tol)에 맞는 점이 하나라도 있는가.
 *  true = 통과, false = 그 날짜대는 있는데 값이 다 틀림(불일치), null = 그 날짜 자체가
 *  창에 없음(검증 불가). tz 오프셋(몇 시간~하루)에도 견고하게 "근처 아무 봉이나 맞으면 OK". */
function anyNear(series: SeriesPoint[], y: number, m: number, d: number, expected: number, tol: number, tolDays: number): boolean | null {
  const target = Date.UTC(y, m - 1, d);
  let sawDate = false;
  for (const p of series) {
    if (Math.abs(p.t - target) <= tolDays * DAY) {
      sawDate = true;
      if (Math.abs(p.v - expected) <= tol) return true;
    }
  }
  return sawDate ? false : null;
}

/**
 * HARD 앵커 검문소 — 각 수집기가 자기 시리즈를 검증. 앵커 날짜가 데이터에 **있는데**
 * 값이 어긋나면 **throw**해서 그 소스를 통째로 거부한다(수집 실패 처리 → 빈 시리즈 →
 * 화면엔 '수집 실패'만, 틀린 숫자는 절대 안 뜸). 앵커 날짜가 아직 없거나 시리즈가
 * 비었으면 no-op(검증 불가 시 통과). "×8 배수 변경·TMPV 컬럼 이동·심볼 변경"을
 * 화면에 이상값이 뜨기 전에 차단하는 게 목적.
 */
export function assertAnchor(
  series: SeriesPoint[],
  y: number,
  m: number,
  d: number,
  expected: number,
  tol: number,
  tolDays: number,
  label: string,
): void {
  if (!series || series.length === 0) return;
  const ok = anyNear(series, y, m, d, expected, tol, tolDays);
  if (ok === false) {
    const target = Date.UTC(y, m - 1, d);
    const nearest = series
      .filter((p) => Math.abs(p.t - target) <= tolDays * DAY)
      .sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0];
    throw new Error(
      `앵커 불일치 [${label}] ${y}-${pad(m)}-${pad(d)}: 계산 ${nearest?.v.toFixed(3) ?? "?"} vs 기준 ${expected}` +
        ` — 파싱/단위/심볼 변경으로 데이터 신뢰 불가 → 저장 거부`,
    );
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (t: number) => {
  const dd = new Date(t);
  return `${dd.getUTCFullYear()}-${pad(dd.getUTCMonth() + 1)}-${pad(dd.getUTCDate())}`;
};

/**
 * 앵커 대조 + 지수 staleness 검사. 경고 문자열 배열을 반환(빈 배열 = 정상).
 * - 시리즈가 비어있으면(수집 실패) 건너뜀 — 그 실패는 다른 곳에서 이미 errors에 남음.
 * - 날짜가 창 밖이면(아직 미수집) 건너뜀.
 */
export function checkAnchors(snap: MarketSnapshot): string[] {
  const h = snap.history;
  const warns: string[] = [];

  for (const a of ANCHORS) {
    const s = a.series(h);
    if (!s || s.length === 0) continue;
    const v = valueOn(s, a.y, a.m, a.d, a.tolDays);
    if (v === null) continue;
    if (Math.abs(v - a.expected) > a.tol) {
      warns.push(
        `⚠️ 앵커 불일치 [${a.label}] ${a.y}-${pad(a.m)}-${pad(a.d)}: 계산 ${v.toFixed(3)} vs 기준 ${a.expected} — 파싱/단위/심볼 변경 의심`,
      );
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

  // 지수(TV)는 실시간, KOFIA는 T+1 → 지수가 KOFIA보다 오래되면 TradingView WS가 조용히
  // 멈춘 것(종가 고정 → F3·F4 왜곡). 2일 넘게 뒤처지면 경고.
  const idxLast = h.kospiClose?.at(-1)?.t;
  const kofiaLast = h.forcedLiqRatio?.at(-1)?.t;
  if (idxLast && kofiaLast && idxLast < kofiaLast - 2 * DAY) {
    warns.push(`⚠️ 코스피 종가가 반대매매(KOFIA)보다 오래됨 — TradingView 지연/끊김 의심 (지수 마지막 ${isoDay(idxLast)}, KOFIA ${isoDay(kofiaLast)})`);
  }

  return warns;
}
