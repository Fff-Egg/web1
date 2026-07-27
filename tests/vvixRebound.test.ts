import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSnapshot, SeriesPoint } from "../src/shared/market.js";
import { __test, computeUsEntry, computeVvixRebound, VVIX_REBOUND_BACKTEST } from "../src/client/pages/usEntry.js";

/**
 * VVIX 단기 반등 확인(보조 신호) 유닛테스트 — 지시서 §17 A~H.
 *
 * ⚠️ 모든 테스트 벡터는 **t 오름차순이고 마지막 원소가 기준일**이다(명세엔 방향이 없었다 —
 * 지금 구현이 오름차순이므로 방향을 판별하는 벡터 B-3을 넣어 회귀를 잡는다).
 * 거래일 = 실제 US 거래일 배열이므로 아래 헬퍼는 주말을 만들지 않는다(달력 주말 미포함 요구 충족).
 */
const DAY = 86_400_000;
/** i번째 거래일(월~금만, 주말 건너뜀) — 달력 주말이 거래일 수에 안 들어감을 명시적으로 만든다. */
function td(i: number): number {
  let d = Date.UTC(2026, 0, 5); // 2026-01-05 = 월요일
  let n = 0;
  while (n < i) {
    d += DAY;
    const w = new Date(d).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return d;
}
const series = (vals: Array<number | null>, from = 0): SeriesPoint[] =>
  vals.flatMap((v, i) => (v === null ? [] : [{ t: td(from + i), v }]));
const snap = (vvix: Array<number | null>, vix: Array<number | null>, extra: Partial<MarketSnapshot["history"]> = {}) =>
  ({ history: { vvix: series(vvix), vix: series(vix), vix3m: [], hyOas: [], ixic: [], ...extra } }) as unknown as MarketSnapshot;

/** 편의: 평평한 VIX(진정 없음) / 내려가는 VIX(진정) */
const FLAT = [20, 20, 20, 20];
const COOL = [20, 20, 20, 19];

// ── A. VVIX 임계값 (엄격 비교) ────────────────────────────────────────────────
test("A-1. 최근 VVIX가 전부 140 미만이면 panicRecent=false", () => {
  const r = computeVvixRebound(snap([100, 139, 139.9, 139.999], COOL));
  assert.equal(r.panicRecent, false);
  assert.equal(r.status, "IDLE");
});

test("A-2. 최근 3거래일 중 하나가 140이면 panicRecent=true", () => {
  const r = computeVvixRebound(snap([100, 139, 140, 138], COOL));
  assert.equal(r.panicRecent, true);
});

test("A-3. 오늘 VVIX=140 → panicToday=true (경계 포함)", () => {
  const r = computeVvixRebound(snap([100, 100, 100, 140], COOL));
  assert.equal(r.panicToday, true);
  assert.equal(r.panicRecent, true);
});

test("A-4. 오늘 VVIX=139.999 → panicToday=false (경계 미만)", () => {
  const r = computeVvixRebound(snap([100, 100, 100, 139.999], COOL));
  assert.equal(r.panicToday, false);
});

// ── B. 3거래일 lookback ──────────────────────────────────────────────────────
test("B-1. 2거래일 전 VVIX=140 → panicRecent=true", () => {
  const r = computeVvixRebound(snap([100, 100, 140, 100, 100], [20, 20, 20, 20, 19]));
  assert.equal(r.panicRecent, true);
  assert.equal(r.vvixRecentMax, 140);
});

test("B-2. 3거래일 전만 140이고 최근 3거래일은 전부 140 미만 → panicRecent=false", () => {
  const r = computeVvixRebound(snap([140, 100, 100, 100], COOL));
  assert.equal(r.panicRecent, false);
  assert.equal(r.status, "IDLE");
});

test("B-3. 벡터 방향 판별 — [140,120,120,120]은 오름차순 해석에서 panicRecent=false", () => {
  // 최신순으로 잘못 읽으면 오늘=140이 되어 true가 되므로 이 케이스가 방향 회귀를 잡는다.
  const r = computeVvixRebound(snap([140, 120, 120, 120], COOL));
  assert.equal(r.panicRecent, false);
  assert.equal(r.panicToday, false);
});

test("B-4. 달력 주말은 거래일 수에 포함되지 않는다", () => {
  // td()가 주말을 건너뛰므로 5행이 월~금이 아니라 실제 거래일 5개다. 3거래일 창은 마지막 3개.
  const r = computeVvixRebound(snap([140, 100, 100, 100, 100], [20, 20, 20, 20, 19]));
  assert.equal(r.panicRecent, false); // 4거래일 전이라 창 밖
});

test("B-5. 데이터 구멍 방어 — 3주 묵은 VVIX 140은 '최근'으로 안 친다", () => {
  const history = {
    vvix: [
      { t: td(0), v: 160 },
      { t: td(1), v: 160 },
      { t: td(2) + 25 * DAY, v: 100 },
    ],
    vix: [
      { t: td(0), v: 30 },
      { t: td(1), v: 30 },
      { t: td(2) + 25 * DAY, v: 20 },
    ],
    vix3m: [],
    hyOas: [],
    ixic: [],
  };
  const r = computeVvixRebound({ history } as unknown as MarketSnapshot);
  assert.equal(r.cooling, true, "VIX는 하락했지만");
  assert.equal(r.panicRecent, false, "묵은 스파이크는 최근이 아니다");
  assert.equal(r.status, "IDLE");
});

// ── C. VIX 진정 (엄격 `<`) ───────────────────────────────────────────────────
test("C-1. VIX 전일 20 → 오늘 19 = cooling true", () => {
  const r = computeVvixRebound(snap([100, 100, 100, 100], [20, 20, 20, 19]));
  assert.equal(r.cooling, true);
  assert.ok(r.vixChange1d !== null && r.vixChange1d < 0);
});

test("C-2. VIX 동률(20 → 20)은 cooling false", () => {
  const r = computeVvixRebound(snap([100, 100, 100, 145], [20, 20, 20, 20]));
  assert.equal(r.cooling, false);
  assert.equal(r.status, "PANIC", "극단이지만 진정 확인은 없음");
});

test("C-3. VIX 상승(20 → 21)은 cooling false", () => {
  const r = computeVvixRebound(snap([100, 100, 100, 100], [20, 20, 20, 21]));
  assert.equal(r.cooling, false);
});

// ── D. 상태 판정 ─────────────────────────────────────────────────────────────
test("D-1. panicRecent=false → IDLE", () => {
  assert.equal(computeVvixRebound(snap([100, 100, 100, 100], COOL)).status, "IDLE");
});

test("D-2. panicRecent=true & cooling=false → PANIC", () => {
  assert.equal(computeVvixRebound(snap([100, 100, 100, 150], FLAT)).status, "PANIC");
});

test("D-3. panicRecent=true & cooling=true → CONFIRMED", () => {
  const r = computeVvixRebound(snap([100, 100, 150, 120], COOL));
  assert.equal(r.status, "CONFIRMED");
  assert.equal(r.confirmed, true);
  assert.equal(r.days, 1);
  assert.equal(r.runStart, r.asOf);
});

test("D-4. VVIX 시리즈 없음 → UNAVAILABLE", () => {
  assert.equal(computeVvixRebound(snap([], COOL)).status, "UNAVAILABLE");
});

test("D-5. 행이 1개뿐(직전 VIX 없음) → UNAVAILABLE", () => {
  assert.equal(computeVvixRebound(snap([150], [20])).status, "UNAVAILABLE");
});

test("D-6. VVIX가 VIX보다 3거래일 넘게 뒤처지면(stale) → UNAVAILABLE", () => {
  // VVIX는 0~1행까지만, VIX는 0~6행까지 → 5거래일 stale. 옛 VVIX 160과 오늘 VIX를 짝지으면 안 된다.
  const r = computeVvixRebound(snap([160, 160], [30, 29, 28, 27, 26, 25, 24]));
  assert.equal(r.status, "UNAVAILABLE");
  assert.ok(r.staleTd !== null && r.staleTd > 3);
});

test("D-7. 값이 NaN/Infinity/null이면 그 행은 무시된다", () => {
  const history = {
    vvix: [
      { t: td(0), v: 150 },
      { t: td(1), v: Number.NaN },
      { t: td(2), v: Number.POSITIVE_INFINITY },
    ],
    vix: [
      { t: td(0), v: 20 },
      { t: td(1), v: 19 },
      { t: td(2), v: 18 },
    ],
    vix3m: [],
    hyOas: [],
    ixic: [],
  };
  const r = computeVvixRebound({ history } as unknown as MarketSnapshot);
  // 유효 행이 1개(td0)뿐 → 직전 행 없음 → UNAVAILABLE
  assert.equal(r.status, "UNAVAILABLE");
});

test("D-8. 서로 다른 UTC 거래일의 VVIX·VIX는 결합하지 않는다 (G. UTC 정렬)", () => {
  const history = {
    vvix: [{ t: td(0), v: 160 }], // 금요일만
    vix: [
      { t: td(1), v: 25 },
      { t: td(2), v: 20 },
    ], // 월·화만
    vix3m: [],
    hyOas: [],
    ixic: [],
  };
  const r = computeVvixRebound({ history } as unknown as MarketSnapshot);
  assert.equal(r.status, "UNAVAILABLE", "교집합이 비어 결합 불가");
  assert.equal(r.history.length, 0);
});

test("D-9. VIX만 있는 날(휴장일 유령봉)은 행에서 제외된다", () => {
  const history = {
    vvix: [
      { t: td(0), v: 150 },
      { t: td(2), v: 150 },
    ],
    vix: [
      { t: td(0), v: 30 },
      { t: td(1), v: 22 }, // VVIX 없는 날 — 제외돼야 함
      { t: td(2), v: 25 },
    ],
    vix3m: [],
    hyOas: [],
    ixic: [],
  };
  const r = computeVvixRebound({ history } as unknown as MarketSnapshot);
  assert.equal(r.history.length, 2);
  assert.equal(r.vixPrev, 30, "직전 행은 유령봉(22)이 아니라 td(0)의 30");
  assert.equal(r.cooling, true, "30 → 25");
});

// ── E. Tier 비침범 ───────────────────────────────────────────────────────────
const t0 = (day: number) => Date.UTC(2026, 0, day);
const usSnap = (h: Partial<MarketSnapshot["history"]>) => ({ history: h }) as unknown as MarketSnapshot;

test("E-1. CONFIRMED여도 A·B·tier0가 전부 false면 fired=false·tier=null", () => {
  const s = usSnap({
    vix: [
      { t: t0(1), v: 20 },
      { t: t0(2), v: 19 },
    ],
    vix3m: [
      { t: t0(1), v: 25 },
      { t: t0(2), v: 25 },
    ], // TERM 0.76 → A/B 미충족
    hyOas: [],
    ixic: [],
    vvix: [
      { t: t0(1), v: 150 },
      { t: t0(2), v: 150 },
    ],
  });
  const u = computeUsEntry(s);
  const r = computeVvixRebound(s);
  assert.equal(r.status, "CONFIRMED");
  assert.equal(u.trackA, false);
  assert.equal(u.trackB, false);
  assert.equal(u.tier, null);
  assert.equal(u.tier0, false);
});

test("E-2. CONFIRMED + A → tier는 여전히 1 (상향 없음)", () => {
  const s = usSnap({
    vix: [
      { t: t0(1), v: 22 },
      { t: t0(2), v: 21 },
    ],
    vix3m: [
      { t: t0(1), v: 20 },
      { t: t0(2), v: 20 },
    ], // TERM 1.05 → A
    hyOas: [],
    ixic: [],
    vvix: [
      { t: t0(1), v: 150 },
      { t: t0(2), v: 150 },
    ],
  });
  const u = computeUsEntry(s);
  assert.equal(computeVvixRebound(s).status, "CONFIRMED");
  assert.equal(u.trackA, true);
  assert.equal(u.tier, 1);
  assert.equal(u.state, "ACTIVE_A");
});

test("E-3. CONFIRMED + A&B → tier=2 (기존 규칙 그대로)", () => {
  const s = usSnap({
    vix: [
      { t: t0(1), v: 22 },
      { t: t0(2), v: 21 },
    ],
    vix3m: [
      { t: t0(1), v: 20 },
      { t: t0(2), v: 20 },
    ],
    hyOas: [{ t: t0(1), v: 5 }],
    ixic: [],
    vvix: [
      { t: t0(1), v: 150 },
      { t: t0(2), v: 150 },
    ],
  });
  const u = computeUsEntry(s);
  assert.equal(computeVvixRebound(s).status, "CONFIRMED");
  assert.equal(u.tier, 2);
  assert.equal(u.state, "ACTIVE_AB");
});

test("E-4. CONFIRMED + MEGA(VIX≥40) → 기존 MEGA 처리 유지", () => {
  const s = usSnap({
    vix: [
      { t: t0(1), v: 45 },
      { t: t0(2), v: 42 },
    ],
    vix3m: [
      { t: t0(1), v: 40 },
      { t: t0(2), v: 40 },
    ], // TERM 1.05 → A
    hyOas: [],
    ixic: [],
    vvix: [
      { t: t0(1), v: 150 },
      { t: t0(2), v: 150 },
    ],
  });
  const u = computeUsEntry(s);
  assert.equal(computeVvixRebound(s).status, "CONFIRMED");
  assert.equal(u.mega, true);
  assert.equal(u.tier, 2, "MEGA는 기존대로 tier 2");
});

// ── F. 하위 호환 (VVIX 없는 옛 스냅샷) ─────────────────────────────────────────
test("F-1. vvix 필드가 없어도 기존 US 진입신호 필드가 전부 동일하다", () => {
  const base: Partial<MarketSnapshot["history"]> = {
    vix: [
      { t: t0(1), v: 20 },
      { t: t0(2), v: 22 },
    ],
    vix3m: [
      { t: t0(1), v: 20 },
      { t: t0(2), v: 20 },
    ],
    hyOas: [{ t: t0(1), v: 5 }],
    ixic: [],
  };
  const withV = computeUsEntry(usSnap({ ...base, vvix: [{ t: t0(2), v: 160 }] }));
  const without = computeUsEntry(usSnap(base)); // vvix 키 자체가 없음(옛 스냅샷)
  const keys = [
    "hasData",
    "asOf",
    "hyAsOf",
    "term",
    "hy",
    "vix",
    "trackA",
    "trackB",
    "mega",
    "state",
    "activeDays",
    "firstFired",
    "nasdaqSince",
    "prevEpisode",
    "dd",
    "above200",
    "tier0",
    "tier",
  ] as const;
  for (const k of keys) {
    assert.deepEqual(withV[k], without[k], `${k}가 VVIX 유무로 달라졌다`);
  }
  assert.deepEqual(withV.termHistory, without.termHistory);
  assert.deepEqual(withV.hyHistory, without.hyHistory);
  assert.deepEqual(withV.ddHistory, without.ddHistory);
});

test("F-2. vvix 필드가 없으면 reboundStatus만 UNAVAILABLE", () => {
  const r = computeVvixRebound(usSnap({ vix: [{ t: t0(1), v: 20 }], vix3m: [], hyOas: [], ixic: [] }));
  assert.equal(r.status, "UNAVAILABLE");
  assert.equal(r.confirmed, false);
});

test("F-3. VIX3M이 없어 메인이 EMPTY여도 보조 신호는 독립적으로 계산된다", () => {
  const s = usSnap({
    vix: [
      { t: t0(1), v: 30 },
      { t: t0(2), v: 28 },
    ],
    vix3m: [], // 메인 신호는 여기서 죽는다
    hyOas: [],
    ixic: [],
    vvix: [
      { t: t0(1), v: 150 },
      { t: t0(2), v: 150 },
    ],
  });
  assert.equal(computeUsEntry(s).hasData, false, "메인은 데이터 없음");
  assert.equal(computeVvixRebound(s).status, "CONFIRMED", "보조는 살아있어야 한다");
});

// ── 상수·순수성 ──────────────────────────────────────────────────────────────
test("상수는 고정값이다 (140 · 3거래일)", () => {
  assert.equal(__test.VVIX_PANIC, 140);
  assert.equal(__test.VVIX_LOOKBACK_TD, 3);
});

test("computeVvixRebound는 입력을 변형하지 않는다(순수)", () => {
  const s = snap([100, 150, 120], COOL.slice(0, 3));
  const before = JSON.stringify(s);
  computeVvixRebound(s);
  assert.equal(JSON.stringify(s), before);
});

// ── 리뷰 회귀 방어 (적대적 리뷰에서 확인된 문제들) ─────────────────────────────
test("R-1. stale로 UNAVAILABLE이어도 과거 CONFIRMED 발생일은 보존된다(차트 캡션 거짓말 방지)", () => {
  // VVIX가 2행에서 끊기고 VIX만 계속 갱신 → stale. 과거 CONFIRMED는 사실이므로 남아야 한다.
  const history = {
    vvix: [
      { t: td(0), v: 150 },
      { t: td(1), v: 150 },
    ],
    vix: [
      { t: td(0), v: 30 },
      { t: td(1), v: 29 }, // 여기서 CONFIRMED 성립
      { t: td(2), v: 28 },
      { t: td(3), v: 27 },
      { t: td(4), v: 26 },
      { t: td(5), v: 25 },
    ],
    vix3m: [],
    hyOas: [],
    ixic: [],
  };
  const r = computeVvixRebound({ history } as unknown as MarketSnapshot);
  assert.equal(r.status, "UNAVAILABLE", "stale이므로 오늘 판정은 못 한다");
  assert.equal(r.confirmedDates.length, 1, "과거 발생일은 사실이라 보존");
  assert.ok(r.history.length > 0, "차트 데이터도 보존");
});

test("R-2. days/runStart는 21거래일 병합이 아니라 연속 런이다", () => {
  // 3거래일 연속 CONFIRMED → days=3, runStart=첫날.
  const r = computeVvixRebound(snap([150, 150, 150, 150], [30, 29, 28, 27]));
  assert.equal(r.status, "CONFIRMED");
  assert.equal(r.days, 3, "td(1),(2),(3) 세 행 (td(0)은 직전 행이 없어 판정 불가)");
  assert.equal(r.runStart, td(1));
});

test("R-3. 조건이 하루 끊기면 연속 런이 리셋된다", () => {
  // VIX: 30,29,30,29 → td(2)는 상승이라 CONFIRMED 아님 → 오늘(td3)은 1일차
  const r = computeVvixRebound(snap([150, 150, 150, 150], [30, 29, 30, 29]));
  assert.equal(r.status, "CONFIRMED");
  assert.equal(r.days, 1, "끊겼으므로 1일차로 리셋");
});

test("R-4. 앱 창 성과표의 중앙값이 산술적으로 맞다 (짝수 n 포함)", () => {
  // 6개월 in-window 실측 4건: −22.80, −10.18, +20.55, +35.50 → 중앙값 = (−10.18+20.55)/2
  const six = VVIX_REBOUND_BACKTEST.inWindow.rows.find((x) => x.label === "6개월");
  assert.ok(six);
  assert.equal(six.n, 4);
  assert.ok(Math.abs(six.median - 5.19) < 0.01, `6개월 중앙값이 ${six.median} — 5.19여야 함`);
  // 승/n 은 항상 0..n
  for (const row of [...VVIX_REBOUND_BACKTEST.inWindow.rows, ...VVIX_REBOUND_BACKTEST.fullSample.rows]) {
    assert.ok(row.wins >= 0 && row.wins <= row.n, `${row.label} 승수 이상`);
    assert.ok(row.worst <= row.median, `${row.label} 최악이 중앙값보다 큼`);
  }
});
