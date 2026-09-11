import assert from "node:assert/strict";
import test from "node:test";
import { computeSizing, shallowGate } from "../src/client/pages/kfear.js";
import { __test as kfearTest } from "../src/client/pages/kfear.js";
import type { SeriesPoint } from "../src/shared/market.js";

test("the shallow gate halves sizing only when both inputs are shallow", () => {
  assert.equal(shallowGate(-0.05, -5), 0.5);
  assert.equal(shallowGate(-0.09, -5), 1);
  assert.equal(shallowGate(-0.05, -8), 1);
  assert.equal(shallowGate(null, null), 0.5);
});

test("grade sizing preserves the validated weights and gate", () => {
  assert.deepEqual(computeSizing("STRONG", -0.05, -5, false), {
    pct: 50,
    weight: 100,
    gate: 0.5,
    path: "GATED",
  });
  assert.deepEqual(computeSizing("BUY", -0.09, -5, false), {
    pct: 60,
    weight: 60,
    gate: 1,
    path: "FULL",
  });
});

test("a KOSDAQ-only signal always stays at zero allocation", () => {
  assert.deepEqual(computeSizing("STRONG", -0.2, -20, true), {
    pct: 0,
    weight: 100,
    gate: 1,
    path: "SOLO",
  });
});

function officialS2ForTail(tail: number[]): boolean {
  const n = 340;
  const start = Date.UTC(2024, 0, 1);
  const points = (values: number[]): SeriesPoint[] => values.map((v, i) => ({ t: start + i * 86_400_000, v }));
  const price = points(Array.from({ length: n }, (_, i) => 1000 - i * 0.2));
  const credit = points(Array.from({ length: n }, () => 100));
  const ratio = points(Array.from({ length: n }, () => 10));
  const amounts = Array.from({ length: n }, (_, i) => (i % 252) + 1);
  amounts.splice(n - tail.length, tail.length, ...tail);
  return kfearTest.buildMarket(price, credit, ratio, points(amounts)).staged.officialS2;
}

test("official v5 S2 state machine remains spike-off then strict-two-declines-on", () => {
  assert.equal(officialS2ForTail([1000]), false);
  assert.equal(officialS2ForTail([1000, 900, 800]), true);
  assert.equal(officialS2ForTail([1000, 900, 950]), false);
  assert.equal(officialS2ForTail([1000, 900, 900]), false);
});

test("official v5 S2 expires when the spike is outside the six-session window", () => {
  assert.equal(officialS2ForTail([1000, 50, 60, 70, 80, 70, 60, 50]), false);
});
