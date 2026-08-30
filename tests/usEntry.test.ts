import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSnapshot, SeriesPoint } from "../src/shared/market.js";
import { __test, computeUsEntry } from "../src/client/pages/usEntry.js";

const DAY = 86_400_000;
const t = (day: number) => Date.UTC(2026, 0, day);
const snapshot = (history: Partial<MarketSnapshot["history"]>) => ({ history }) as MarketSnapshot;

test("US entry uses the previous observation for HY and activates AB", () => {
  const result = computeUsEntry(
    snapshot({
      vix: [
        { t: t(1), v: 20 },
        { t: t(2), v: 22 },
      ],
      vix3m: [
        { t: t(1), v: 20 },
        { t: t(2), v: 20 },
      ],
      hyOas: [{ t: t(1), v: 5 }],
      ixic: [],
    }),
  );

  assert.equal(result.state, "ACTIVE_AB");
  assert.equal(result.trackA, true);
  assert.equal(result.trackB, true);
  assert.equal(result.hy, 5);
  assert.equal(result.tier, 2);
});

test("TERM approaching inversion produces WATCH without a shifted HY value", () => {
  const result = computeUsEntry(
    snapshot({
      vix: [{ t: t(1), v: 19.2 }],
      vix3m: [{ t: t(1), v: 20 }],
      hyOas: [],
      ixic: [],
    }),
  );
  assert.equal(result.state, "WATCH");
  assert.equal(result.trackA, false);
  assert.equal(result.trackB, false);
});

test("Tier 0 turns on for a deep pullback that remains above the 200-day average", () => {
  const ixic: SeriesPoint[] = Array.from({ length: 260 }, (_, i) => ({
    t: t(1) + i * DAY,
    v: i === 259 ? 180 : 100 + (100 * i) / 259,
  }));
  const result = __test.computeTier0(ixic);
  assert.equal(result.tier0, true);
  assert.equal(result.above200, true);
  assert.ok(result.dd !== null && result.dd <= -0.08);
});

test("US entry returns an explicit empty state when TERM inputs are missing", () => {
  assert.equal(computeUsEntry(snapshot({})).hasData, false);
});
