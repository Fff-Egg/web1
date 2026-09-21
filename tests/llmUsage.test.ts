import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { complete } from "../src/server/analysis/anthropic.js";
import { withLlmUsageSink, withLlmUsageContext, observeLlmUsage } from "../src/server/analysis/usageObservation.js";
import { completeDigestStage, newModelTrace } from "../src/server/digest/modelPipeline.js";
import { usageDateRange } from "../src/server/repo/llmUsage.js";
import type { LlmUsageEvent } from "../src/shared/llmUsage.js";

const originalFetch = globalThis.fetch;
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY"] as const;
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const opts = { model: "deepseek-flash", system: "PRIVATE_SYSTEM", user: "PRIVATE_INPUT", thinking: "disabled" as const,
  usage: { stage: "filter" as const, articleId: 42 } };
beforeEach(() => {
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "PRIVATE_KEY";
  delete process.env.LLM_EXTRA_BODY;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
function response(usage?: unknown, finish = "stop") {
  return new Response(JSON.stringify({ choices: [{ message: { content: "PRIVATE_OUTPUT" }, finish_reason: finish }], usage }));
}
function sse(data: unknown) { return `data: ${JSON.stringify(data)}\n\n`; }
const counts = { prompt_tokens: 100, completion_tokens: 35, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
  completion_tokens_details: { reasoning_tokens: 11 } };

test("JSON attempt records provider counts and actual wire settings without content or credentials", async () => {
  const events: LlmUsageEvent[] = [];
  process.env.LLM_EXTRA_BODY = JSON.stringify({ model: "deepseek-flash-custom", thinking: { type: "enabled" } });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "deepseek-flash-custom");
    assert.equal(body.thinking.type, "disabled"); // Per-stage OFF overrides stale global ON.
    assert.equal(body.usage, undefined);
    return response(counts);
  };
  const result = await withLlmUsageSink(e => { events.push(e); }, () => complete(opts));
  assert.equal(result, "PRIVATE_OUTPUT"); assert.equal(calls, 1); assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.stage, "filter"); assert.equal(e.articleId, 42); assert.equal(e.success, true);
  assert.equal(e.model, "deepseek-flash-custom"); assert.equal(e.thinking, "disabled");
  assert.equal(e.endpointHost, "api.deepseek.com");
  assert.deepEqual([e.inputTokens, e.cacheHitTokens, e.cacheMissTokens, e.outputTokens, e.reasoningTokens], [100, 80, 20, 35, 11]);
  assert.doesNotMatch(JSON.stringify(e), /PRIVATE_|Bearer|reasoning_content/);
});

test("truncated response is a failed attempt but retains consumed tokens", async () => {
  const events: LlmUsageEvent[] = [];
  globalThis.fetch = async () => response(counts, "length");
  await withLlmUsageSink(e => { events.push(e); }, () => assert.rejects(complete(opts), /응답 잘림/));
  assert.equal(events.length, 1); assert.equal(events[0].success, false);
  assert.equal(events[0].outputTokens, 35); assert.equal(events[0].finishReason, "length");
});

test("malformed JSON and SSE message shapes still retain valid billed usage", async () => {
  const events: LlmUsageEvent[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 123 } }], usage: counts }));
  await withLlmUsageSink(e => { events.push(e); }, () => assert.rejects(complete(opts)));
  globalThis.fetch = async () => new Response(sse({ choices: "invalid", usage: counts }));
  await withLlmUsageSink(e => { events.push(e); }, () => assert.rejects(complete({ ...opts, thinking: "enabled" })));
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.success, false); assert.equal(event.outputTokens, 35);
    assert.equal(event.inputTokens, 100); assert.equal(event.cacheHitTokens, 80);
  }
});

test("SSE usage-only event preserves cache and reasoning details", async () => {
  const events: LlmUsageEvent[] = [];
  globalThis.fetch = async () => new Response(
    sse({ choices: [{ index: 0, delta: { content: "PRIVATE_OUTPUT" }, finish_reason: "stop" }] }) +
    sse({ choices: [], usage: counts }) + "data: [DONE]\n\n");
  await withLlmUsageSink(e => { events.push(e); }, () => complete({ ...opts, thinking: "enabled", usage: { stage: "digest_final", runId: "dg-test" } }));
  assert.equal(events[0].thinking, "enabled"); assert.equal(events[0].runId, "dg-test");
  assert.deepEqual([events[0].inputTokens, events[0].cacheHitTokens, events[0].cacheMissTokens, events[0].outputTokens, events[0].reasoningTokens], [100, 80, 20, 35, 11]);
});

test("interrupted SSE retains supplied usage while keeping the result failed", async () => {
  const events: LlmUsageEvent[] = [];
  globalThis.fetch = async () => {
    let step = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) {
      if (!step++) c.enqueue(new TextEncoder().encode(sse({ choices: [], usage: counts })));
      else c.error(new Error("PRIVATE_PROVIDER_ERROR"));
    } }));
  };
  await withLlmUsageSink(e => { events.push(e); }, () => assert.rejects(complete({ ...opts, thinking: "enabled" })));
  assert.equal(events[0].success, false); assert.equal(events[0].outputTokens, 35);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test("missing usage stays unknown; explicit zero stays zero", async () => {
  const events: LlmUsageEvent[] = [];
  globalThis.fetch = async () => response();
  await withLlmUsageSink(e => { events.push(e); }, () => complete(opts));
  assert.equal(events[0].inputTokens, null); assert.equal(events[0].outputTokens, null);
  assert.equal(events[0].reasoningTokens, null);
  globalThis.fetch = async () => response({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });
  await withLlmUsageSink(e => { events.push(e); }, () => complete(opts));
  assert.equal(events[1].inputTokens, 0); assert.equal(events[1].outputTokens, 0); assert.equal(events[1].cacheHitTokens, 0);
  assert.equal(events[1].reasoningTokens, null);
  globalThis.fetch = async () => new Response("PRIVATE_ERROR", { status: 402 });
  await withLlmUsageSink(e => { events.push(e); }, () => assert.rejects(complete(opts)));
  assert.equal(events[2].success, false); assert.equal(events[2].httpStatus, 402); assert.equal(events[2].outputTokens, null);
});

test("throwing ledger sink cannot cause digest retry or replace successful output", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(counts); };
  const trace = newModelTrace("deepseek-flash", "deepseek-flash");
  const result = await withLlmUsageSink(() => { throw Error("PRIVATE_SINK_ERROR"); },
    () => completeDigestStage(opts, { stage: "map" }, trace));
  assert.equal(result, "PRIVATE_OUTPUT"); assert.equal(calls, 1); assert.equal(trace.stages.map.retries, 0);
});

test("concurrent stage contexts and sinks do not leak into one another", async () => {
  const left: LlmUsageEvent[] = [], right: LlmUsageEvent[] = [];
  let release!: () => void;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.messages[1].content === "slow") await new Promise<void>(r => { release = r; });
    return response(counts);
  };
  const first = withLlmUsageContext({ runId: "dg-left" }, () => withLlmUsageSink(e => { left.push(e); }, () => complete({ ...opts, user: "slow", usage: { stage: "whole_reading", articleId: 1 } })));
  await withLlmUsageContext({ runId: "dg-right" }, () => withLlmUsageSink(e => { right.push(e); }, () => complete({ ...opts, usage: { stage: "research_summary" } })));
  release(); await first;
  assert.equal(left.length, 1); assert.equal(right.length, 1);
  assert.equal(left[0].stage, "whole_reading"); assert.equal(left[0].articleId, 1);
  assert.equal(right[0].stage, "research_summary"); assert.equal(right[0].articleId, null);
  assert.equal(left[0].runId, "dg-left"); assert.equal(right[0].runId, "dg-right");
  assert.notEqual(left[0].requestId, right[0].requestId);
});

test("stalled usage sink is bounded and late rejection is handled", async () => {
  let reject!: (error: Error) => void;
  const event = { requestId: "test" } as LlmUsageEvent;
  const started = performance.now();
  await withLlmUsageSink(() => new Promise<void>((_resolve, r) => { reject = r; }), () => observeLlmUsage(event, 5));
  assert.ok(performance.now() - started < 250);
  reject(new Error("PRIVATE_LATE_ERROR"));
  await new Promise(r => setImmediate(r));
});

test("usage report starts at midnight KST six days earlier", () => {
  assert.deepEqual(usageDateRange(new Date("2026-09-21T15:01:00Z")), {
    since: new Date("2026-09-15T15:00:00Z"), until: new Date("2026-09-21T15:01:00Z"),
  });
});
