import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { complete } from "../src/server/analysis/anthropic.js";
import { completeDigestStage, newModelTrace, digestCleanupGate } from "../src/server/digest/modelPipeline.js";
import type { LlmCallDiagnostics } from "../src/shared/llmDiagnostics.js";
import { LlmDiagnosticsPanel } from "../src/client/components/LlmDiagnosticsPanel.js";

const originalFetch = globalThis.fetch;
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY", "LLM_MODEL"] as const;
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
function setup() {
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "PRIVATE_KEY";
  delete process.env.LLM_EXTRA_BODY;
  let diagnostics: LlmCallDiagnostics | undefined;
  return {
    opts: { model: "deepseek-v4-pro", system: "PRIVATE_SYSTEM", user: "PRIVATE_ARTICLE", thinking: "enabled" as const, maxTokens: 49152,
      onDiagnostics: (d: LlmCallDiagnostics) => { diagnostics = d; } },
    get: () => { assert.ok(diagnostics); return diagnostics; },
  };
}
const event = (delta: object, finish_reason: string | null = null, usage?: object) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\r\n\r\n`;
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (i < bytes.length) c.enqueue(bytes.slice(i, ++i));
    else c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const full = (reason = "stop") => ": keep-alive\r\n\r\n" + event({ reasoning_content: "PRIVATE_REASONING" }) +
  event({ content: "분석 완료 🚀" }) + event({}, reason, { prompt_tokens: 120, completion_tokens: 33 }) + "data: [DONE]\r\n\r\n";
const reset = () => new TypeError("terminated", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

test("final Pro receives split UTF-8 SSE without changing thinking or budget, or adding calls", async () => {
  const { opts, get } = setup();
  process.env.LLM_EXTRA_BODY = JSON.stringify({ stream: false, thinking: { type: "disabled" }, reasoning_effort: "high" });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true); assert.equal(body.max_tokens, 49152);
    assert.deepEqual(body.thinking, { type: "enabled" }); assert.equal(body.reasoning_effort, "high");
    assert.equal(init?.signal, undefined);
    return stream(full());
  };
  assert.equal(await complete(opts), "분석 완료 🚀");
  assert.equal(calls, 1);
  const d = get(); assert.equal(d.stage, "complete"); assert.equal(d.stream, true); assert.equal(d.streamCompleted, true);
  assert.equal(d.reasoningChars, "PRIVATE_REASONING".length); assert.equal(d.completionTokens, 33);
  assert.equal(d.contentChars, "분석 완료 🚀".length); assert.equal(d.finishReason, "stop");
  assert.ok(d.firstReasoningMs !== undefined && d.firstContentMs !== undefined);
  // CR alone dispatches the terminal blank line; the reader is cancelled before
  // the final LF arrives in this deliberately byte-at-a-time response.
  assert.equal(d.receivedBytes, new TextEncoder().encode(full()).length - 1);
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE_/);
  const html = renderToStaticMarkup(createElement(LlmDiagnosticsPanel, { diagnostics: d }));
  assert.match(html, /첫 사고 응답/); assert.match(html, /스트림 종료 신호 수신/);
  assert.doesNotMatch(html, /PRIVATE_/);
  assert.equal(await complete({ ...opts, onDiagnostics: () => { throw Error("observer"); } }), "분석 완료 🚀");
  assert.equal(calls, 2);
});

// These IDs exercise family matching only; fixtures do not assert availability.
for (const model of ["deepseek-flash", "future-model-fixture", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4.1-pro"]) {
test(`${model} final thinking streams while filter/map remain non-thinking`, async () => {
  const { opts } = setup();
  process.env.LLM_EXTRA_BODY = JSON.stringify({ thinking: { type: "enabled" }, stream: false });
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return body.stream ? stream(full()) : new Response(JSON.stringify({ choices: [{ message: { content: "정리 완료" }, finish_reason: "stop" }] }));
  };
  assert.equal(await complete({ ...opts, model, thinking: "disabled", maxTokens: 8000 }), "정리 완료");
  assert.equal(bodies[0].thinking.type, "disabled"); assert.equal(bodies[0].stream, false);
  assert.equal(await complete({ ...opts, model }), "분석 완료 🚀");
  assert.equal(bodies[1].thinking.type, "enabled"); assert.equal(bodies[1].stream, true);
  assert.equal(bodies[1].max_tokens, 49152); assert.equal(bodies.length, 2);
  delete process.env.LLM_EXTRA_BODY;
  assert.equal(await complete({ ...opts, model, thinking: undefined }), "정리 완료");
  assert.equal(bodies[2].thinking.type, "disabled"); assert.equal(bodies[2].stream, undefined);
});
}

for (const model of ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4.1-flash"]) {
test(`mid-stream reset discards partial ${model} text and invokes non-thinking fallback once without sweep`, async () => {
  const { opts } = setup();
  opts.model = model;
  const fallbackModel = model === "deepseek-v4-pro" ? "deepseek-v4-flash" : model;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length > 1) return new Response(JSON.stringify({ choices: [{ message: { content: "Flash 완성본" }, finish_reason: "stop" }] }));
    let first = true;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) {
      if (first) { first = false; c.enqueue(new TextEncoder().encode(event({ reasoning_content: "PRIVATE_REASONING" }) + event({ content: "PRIVATE_PARTIAL" }))); }
      else c.error(reset());
    } }), { status: 200 });
  };
  const trace = newModelTrace(fallbackModel, opts.model);
  assert.equal(await completeDigestStage(opts, { stage: "final", retryPrimary: false, fallbackModel, fallbackThinking: "disabled", fallbackMaxTokens: 8192 }, trace), "Flash 완성본");
  assert.equal(bodies.length, 2); assert.equal(bodies[0].stream, true); assert.equal(bodies[1].stream, undefined);
  assert.equal(bodies[0].model, model); assert.equal(bodies[1].model, fallbackModel);
  assert.equal(bodies[1].thinking.type, "disabled"); assert.equal(bodies[1].max_tokens, 8192);
  assert.equal(trace.stages.final.retries, 0); assert.equal(trace.stages.final.fallbacks, 1);
  assert.equal(digestCleanupGate(trace).eligible, false);
  const d = trace.stages.final.errors[0].diagnostics!;
  assert.equal(d.stage, "reading_body"); assert.equal(d.streamCompleted, false);
  assert.deepEqual(d.errorCodes, ["ECONNRESET"]); assert.equal(d.contentChars, "PRIVATE_PARTIAL".length);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_/);
});
}

test("known incomplete finish reasons reject partial content even with DONE", async () => {
  const { opts, get } = setup();
  for (const reason of ["length", "content_filter", "insufficient_system_resource", "tool_calls"]) {
    globalThis.fetch = async () => stream(full(reason));
    await assert.rejects(complete(opts), new RegExp(`finish_reason=${reason}`));
    assert.equal(get().stage, "validating_response"); assert.equal(get().finishReason, reason);
    assert.equal(get().completionTokens, 33);
  }
});

test("non-thinking Flash/Pro and unrelated models retain JSON transport; resolved Pro streams", async () => {
  const { opts } = setup();
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return body.stream ? stream(full()) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  };
  for (const call of [{ model: "deepseek-v4-flash", thinking: "disabled" as const }, { model: "deepseek-v4-pro", thinking: "disabled" as const }, { model: "another-model", thinking: "enabled" as const }]) {
    if (call.model === "another-model") process.env.LLM_BASE_URL = "https://another-provider.example/v1";
    assert.equal(await complete({ ...opts, ...call }), "ok");
  }
  assert.ok(bodies.every(body => body.stream === undefined));
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_MODEL = "deepseek-v4-pro";
  assert.equal(await complete({ ...opts, model: "claude-old-saved-id" }), "분석 완료 🚀");
  assert.equal(bodies[3].stream, true); assert.equal(bodies[3].model, "deepseek-v4-pro");
});

test("DONE ends response consumption and cancels an otherwise open stream", async () => {
  const { opts } = setup();
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(full())); },
    cancel() { cancelled = true; },
  }));
  assert.equal(await complete(opts), "분석 완료 🚀");
  assert.equal(cancelled, true);
});
