import assert from "node:assert/strict";
import test from "node:test";
import { readingStageEffort, readingStageModel, readingStageThinking } from "../src/shared/llmModels.js";
import { analysisConfigFingerprint } from "../src/server/analysis/retryPolicy.js";

test("long-article reading follows the 자료 정리 setting until its own is saved", () => {
  const base = { instructions: "", filterModel: "claude-haiku-5-5", filterEffort: "high" as const,
    digestMapModel: "claude-sonnet-5-5", digestMapEffort: "low" as const, digestMapThinking: "enabled" as const };
  // Unset: identical to the previous behaviour (map model, map effort, map thinking).
  assert.equal(readingStageModel(base, "fallback"), "claude-sonnet-5-5");
  assert.equal(readingStageEffort(base), "low");
  assert.equal(readingStageThinking(base), "enabled");
  // Map unset too: falls through to the filter model and inherits its effort via the map.
  assert.equal(readingStageModel({}, "claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(readingStageEffort({ filterEffort: "medium" }), "medium");
  // Own model: own effort, else the model default (not the map's), Thinking OFF by default.
  const split = { ...base, readingModel: "claude-haiku-5-5" };
  assert.equal(readingStageModel(split, "fallback"), "claude-haiku-5-5");
  assert.equal(readingStageEffort(split), undefined);
  assert.equal(readingStageEffort({ ...split, readingEffort: "medium" }), "medium");
  assert.equal(readingStageThinking(split), "disabled");
});

test("retry fingerprints stay identical without a reading setting and change with one", () => {
  const cfg = { instructions: "x", filterModel: "claude-haiku-5-5", digestMapModel: "claude-sonnet-5-5" };
  const before = analysisConfigFingerprint(cfg, false);
  assert.equal(analysisConfigFingerprint({ ...cfg, readingModel: "", readingEffort: undefined }, false), before);
  assert.notEqual(analysisConfigFingerprint({ ...cfg, readingModel: "claude-haiku-5-5" }, false), before);
  assert.notEqual(analysisConfigFingerprint({ ...cfg, readingEffort: "high" }, false), before);
  // Saving values equal to what is already inherited is not a real change: holds stay.
  assert.equal(analysisConfigFingerprint({ ...cfg, readingThinking: "disabled" }, false), before);
  assert.equal(analysisConfigFingerprint({ ...cfg, readingModel: "claude-sonnet-5-5" }, false), before);
  const withMapEffort = { ...cfg, digestMapEffort: "low" as const };
  assert.equal(analysisConfigFingerprint({ ...withMapEffort, readingEffort: "low" }, false), analysisConfigFingerprint(withMapEffort, false));
});
