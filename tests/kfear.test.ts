import assert from "node:assert/strict";
import test from "node:test";
import { computeSizing, shallowGate } from "../src/client/pages/kfear.js";

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
