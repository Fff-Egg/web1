import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  complete, providerFor, resolveModel, setAnthropicClientForTests, CLAUDE_MIN_MAX_TOKENS,
} from "../src/server/analysis/anthropic.js";
import { withLlmUsageSink } from "../src/server/analysis/usageObservation.js";
import { isLlmOutputLimitError } from "../src/server/analysis/llmErrors.js";
import { LlmProviderError } from "../src/server/analysis/providerError.js";
import { analysisFailureReason, globalPauseMinutes } from "../src/server/analysis/retryPolicy.js";
import { digestFinalTokenBudget, CLAUDE_FINAL_MAX_TOKENS } from "../src/server/digest/modelPipeline.js";
import { setAnalysisFilterProviderHint, shouldDeferAutomaticAnalysis } from "../src/server/analysis/schedule.js";
import { effortFor, mapStageEffort, claudeCostUsd } from "../src/shared/llmModels.js";
import { usageEstimate } from "../src/shared/llmUsageView.js";
import type { LlmUsageEvent } from "../src/shared/llmUsage.js";

const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "ANTHROPIC_API_KEY", "ANALYSIS_AVOID_PEAK"] as const;
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

interface Captured { url: string; body: Record<string, unknown>; headers: Headers }
let captured: Captured[] = [];

function sse(events: { event: string; data: unknown }[]): Response {
  const text = events.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function message(text: string, stopReason: string, model = "claude-sonnet-5-5"): Response {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...(text ? [{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }] : []),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 35 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}
function useClaude(respond: () => Response): void {
  setAnthropicClientForTests(new Anthropic({
    apiKey: "PRIVATE_KEY", maxRetries: 0,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return respond();
    },
  }));
}

beforeEach(() => {
  captured = [];
  process.env.ANTHROPIC_API_KEY = "PRIVATE_KEY";
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "DS_KEY";
  process.env.LLM_MODEL = "deepseek-flash";
});
afterEach(() => {
  setAnthropicClientForTests(null);
  setAnalysisFilterProviderHint(false);
  globalThis.fetch = originalFetch;
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});

const base = { system: "PRIVATE_SYSTEM", user: "PRIVATE_INPUT", usage: { stage: "filter" as const, articleId: 7 } };

test("provider is chosen per model: claude-* → Claude API, others → DeepSeek", () => {
  assert.equal(providerFor("claude-sonnet-5-5"), "anthropic");
  assert.equal(providerFor("deepseek-flash"), "openai-compatible");
  assert.equal(resolveModel("claude-opus-5-5"), "claude-opus-5-5");
  delete process.env.ANTHROPIC_API_KEY; // DeepSeek-only deployment keeps the old remap.
  assert.equal(providerFor("claude-opus-5-5"), "openai-compatible");
  assert.equal(resolveModel("claude-opus-5-5"), "deepseek-flash");
});

test("Claude request: adaptive thinking, effort, cached system, server fallback, streaming", async () => {
  useClaude(() => message("PRIVATE_OUTPUT", "end_turn"));
  let deepseekCalls = 0;
  globalThis.fetch = async () => { deepseekCalls++; return new Response("{}"); };
  const events: LlmUsageEvent[] = [];
  const out = await withLlmUsageSink(e => { events.push(e); },
    () => complete({ ...base, model: "claude-sonnet-5-5", effort: "low", maxTokens: 1600, thinking: "disabled", responseFormat: "json_object" }));
  assert.equal(out, "PRIVATE_OUTPUT");
  assert.equal(deepseekCalls, 0);
  assert.equal(captured.length, 1);
  const body = captured[0].body;
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.max_tokens, CLAUDE_MIN_MAX_TOKENS);
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, "default");
  assert.equal(body.temperature, undefined);
  assert.equal(body.response_format, undefined);
  assert.deepEqual((body.system as { cache_control: unknown }[])[0].cache_control, { type: "ephemeral" });
  assert.match(captured[0].headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  const e = events[0];
  assert.equal(e.success, true); assert.equal(e.endpointHost, "api.anthropic.com"); assert.equal(e.thinking, "enabled");
  assert.deepEqual([e.inputTokens, e.cacheHitTokens, e.cacheMissTokens, e.outputTokens], [200, 80, 120, 35]);
  assert.doesNotMatch(JSON.stringify(e), /PRIVATE_/);
});

test("Haiku gets no fallback parameter and falls back to its default effort", async () => {
  useClaude(() => message("ok", "end_turn", "claude-haiku-5-5"));
  await complete({ ...base, model: "claude-haiku-5-5" });
  assert.equal(captured[0].body.fallbacks, undefined);
  assert.deepEqual(captured[0].body.output_config, { effort: "medium" });
});

test("max_tokens stop is an output-limit error, never a partial success", async () => {
  useClaude(() => message("PARTIAL", "max_tokens"));
  await assert.rejects(complete({ ...base, model: "claude-sonnet-5-5" }), (error: unknown) => {
    assert.ok(isLlmOutputLimitError(error));
    assert.equal(analysisFailureReason(error), "output_limit");
    return true;
  });
});

test("refusal after fallback is held as a content-policy rejection", async () => {
  useClaude(() => message("", "refusal"));
  await assert.rejects(complete({ ...base, model: "claude-opus-5-5" }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.category, "content_policy");
    assert.equal(analysisFailureReason(error), "request_rejected");
    return true;
  });
});

test("empty Claude answer throws instead of passing silently", async () => {
  useClaude(() => message("", "end_turn"));
  await assert.rejects(complete({ ...base, model: "claude-sonnet-5-5" }), /LLM 빈 응답/);
});

test("exhausted Claude credits pause automatic analysis for 6 hours", async () => {
  useClaude(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }),
    { status: 400, headers: { "content-type": "application/json" } }));
  await assert.rejects(complete({ ...base, model: "claude-sonnet-5-5" }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.category, "balance");
    assert.doesNotMatch(error.message, /credit balance/); // provider text is never stored
    const reason = analysisFailureReason(error);
    assert.equal(reason, "balance");
    assert.equal(globalPauseMinutes(reason), 360);
    return true;
  });
});

test("Claude final report gets a large streaming ceiling", () => {
  assert.equal(digestFinalTokenBudget("claude-opus-5-5", 8192), CLAUDE_FINAL_MAX_TOKENS);
  assert.ok(digestFinalTokenBudget("deepseek-flash", 8192) < CLAUDE_FINAL_MAX_TOKENS);
});

test("effort catalog: per-model defaults, map inherits the filter effort", () => {
  assert.equal(effortFor("claude-opus-5-5"), "medium");
  assert.equal(effortFor("claude-sonnet-5-5"), "high");
  assert.equal(effortFor("claude-sonnet-5-5", "low"), "low");
  assert.equal(effortFor("deepseek-flash", "low"), undefined);
  assert.equal(mapStageEffort({ filterEffort: "low" }), "low");
  assert.equal(mapStageEffort({ digestMapModel: "claude-sonnet-5-5", filterEffort: "low" }), undefined);
  assert.equal(mapStageEffort({ digestMapEffort: "high", filterEffort: "low" }), "high");
});

test("Claude cost estimate uses list prices", () => {
  const usd = claudeCostUsd("claude-sonnet-5-5", { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(usd, 0.2 + 2 + 10);
  const row = { model: "claude-opus-5-5", endpointHost: "api.anthropic.com",
    costBasis: { requests: 2, cacheHitTokens: 0, cacheMissTokens: 1_000_000, outputTokens: 0 } };
  assert.deepEqual(usageEstimate(row), { usd: 4, requests: 2 });
});

test("peak-hour waiting applies only to a DeepSeek filter", () => {
  delete process.env.ANALYSIS_AVOID_PEAK;
  const elevenKst = new Date("2026-11-04T02:00:00Z");
  assert.equal(shouldDeferAutomaticAnalysis(elevenKst), true);
  setAnalysisFilterProviderHint(true);
  assert.equal(shouldDeferAutomaticAnalysis(elevenKst), false);
});
