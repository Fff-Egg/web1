import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { discountedFlashEstimate, usageKstDay, usageFailureLabel } from "../src/shared/llmUsageView.js";
import type { LlmUsageBucket } from "../src/shared/llmUsage.js";
import { getRuntimeSchedule } from "../src/server/runtimeSchedule.js";

const row = { endpointHost: "api.deepseek.com", model: "deepseek-flash",
  costBasis: { requests: 3, cacheHitTokens: 2_000_000, cacheMissTokens: 1_000_000, outputTokens: 500_000 } } as LlmUsageBucket;

test("discounted estimate applies the three published per-million rates", () => {
  const estimate = discountedFlashEstimate(row)!;
  assert.ok(Math.abs(estimate.usd - 0.456) < 1e-12);
  assert.equal(estimate.requests, 3);
});
test("unknown, other providers and unpriced models never get a fabricated zero bill", () => {
  assert.equal(discountedFlashEstimate({ ...row, costBasis: { ...row.costBasis, requests: 0 } }), null);
  assert.equal(discountedFlashEstimate({ ...row, endpointHost: "proxy.example.com" }), null);
  assert.equal(discountedFlashEstimate({ ...row, model: "deepseek-v4-pro" }), null);
  assert.equal(discountedFlashEstimate({ ...row, costBasis: { ...row.costBasis, outputTokens: -1 } }), null);
  assert.deepEqual(discountedFlashEstimate({ ...row, costBasis: { requests: 1, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 } }), { usd: 0, requests: 1 });
});

test("today follows the server report's KST date, including the UTC day boundary", () => {
  assert.equal(usageKstDay("2026-09-21T14:59:59.999Z"), "2026-09-21");
  assert.equal(usageKstDay("2026-09-21T15:00:00.000Z"), "2026-09-22");
});
test("failure labels distinguish known truncation and HTTP errors without guessing unknown causes", () => {
  assert.equal(usageFailureLabel({ httpStatus: 200, finishReason: "length" }), "출력 한도 초과 (응답 잘림)");
  assert.equal(usageFailureLabel({ httpStatus: null, finishReason: "max_tokens" }), "출력 한도 초과 (응답 잘림)");
  assert.equal(usageFailureLabel({ httpStatus: 400, finishReason: null }), "요청 오류 (HTTP 400)");
  assert.equal(usageFailureLabel({ httpStatus: 400, finishReason: null, errorCategory: "invalid_unicode", errorParam: "messages.content" }), "문자 인코딩 오류 (HTTP 400) · messages.content");
  assert.equal(usageFailureLabel({ httpStatus: 400, finishReason: null, errorCategory: "context_limit" }), "입력·출력 합산 한도 초과 (HTTP 400)");
  assert.equal(usageFailureLabel({ httpStatus: 200, finishReason: null }), "응답 처리 실패 (상세 미확인)");
});

const keys = ["DIGEST_HOUR", "DIGEST_MIDDAY_HOUR", "ANALYSIS_AVOID_PEAK", "DISABLE_SCHEDULERS"] as const;
const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
test("runtime display reads actual 07/14 settings and preserves both pause windows", () => {
  process.env.DIGEST_HOUR = "7"; process.env.DIGEST_MIDDAY_HOUR = "14";
  process.env.ANALYSIS_AVOID_PEAK = "1"; delete process.env.DISABLE_SCHEDULERS;
  const value = getRuntimeSchedule(new Date("2026-09-21T11:00:00+09:00"));
  assert.equal(value.digestHour, 7); assert.equal(value.middayHour, 14);
  assert.equal(value.middayHourSource, "railway"); assert.equal(value.automaticEnabled, true);
  assert.equal(value.analysisDeferred, true);
  assert.deepEqual(value.pauseWindows, [{ startMinute: 600, endMinute: 780 }, { startMinute: 900, endMinute: 1140 }]);
  assert.deepEqual(value.resumeHours, [13, 19]);
  assert.equal(getRuntimeSchedule(new Date("2026-09-21T14:00:00+09:00")).analysisDeferred, false);
  assert.equal(process.env.DIGEST_MIDDAY_HOUR, "14");
});
test("runtime display distinguishes existing defaults and disabled avoidance", () => {
  delete process.env.DIGEST_HOUR; delete process.env.DIGEST_MIDDAY_HOUR;
  process.env.ANALYSIS_AVOID_PEAK = "0"; process.env.DISABLE_SCHEDULERS = "1";
  const value = getRuntimeSchedule(new Date("2026-09-21T11:00:00+09:00"));
  assert.equal(value.digestHour, 7); assert.equal(value.middayHour, 17);
  assert.equal(value.middayHourSource, "default"); assert.equal(value.peakAvoidanceEnabled, false);
  assert.equal(value.automaticEnabled, false); assert.equal(value.analysisDeferred, false);
});
