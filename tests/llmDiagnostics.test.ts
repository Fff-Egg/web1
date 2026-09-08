import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { complete } from "../src/server/analysis/anthropic.js";
import { completeDigestStage, newModelTrace } from "../src/server/digest/modelPipeline.js";
import { LlmDiagnosticsPanel } from "../src/client/components/LlmDiagnosticsPanel.js";
import type { LlmCallDiagnostics } from "../src/shared/llmDiagnostics.js";

const fetchBefore = globalThis.fetch;
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY"] as const;
const envBefore = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = fetchBefore;
  for (const key of keys) { if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key]; }
});
function setup() {
  process.env.LLM_BASE_URL = "https://llm.example/v1";
  process.env.LLM_API_KEY = "PRIVATE_API_KEY";
  delete process.env.LLM_EXTRA_BODY;
  let observed: LlmCallDiagnostics | undefined;
  return {
    opts: { model: "deepseek-v4-pro", system: "PRIVATE_SYSTEM", user: "PRIVATE_ARTICLE", maxTokens: 49152, thinking: "enabled" as const, onDiagnostics: (d: LlmCallDiagnostics) => { observed = d; } },
    get: () => { assert.ok(observed); return observed; },
  };
}
function success() { return new Response(JSON.stringify({ choices: [{ message: { content: "report" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } })); }
function reset() { return new TypeError("terminated", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); }
function noSecrets(d: unknown) { assert.doesNotMatch(JSON.stringify(d), /PRIVATE_|Bearer/); }

test("pre-header rejection records stage and cause, not invented zero usage", async () => {
  const { opts, get } = setup();
  globalThis.fetch = async () => { throw reset(); };
  await assert.rejects(complete(opts), /terminated/);
  const d = get();
  assert.equal(d.stage, "awaiting_headers"); assert.equal(d.receivedBytes, 0);
  assert.equal(d.httpStatus, undefined); assert.equal(d.completionTokens, undefined);
  assert.deepEqual(d.errorCodes, ["ECONNRESET"]); assert.ok(d.durationMs >= 0);
  assert.equal(d.endpointHost, "llm.example"); noSecrets(d);
});

test("mid-body reset records received bytes, HTTP 200, timings; one Pro then Flash", async () => {
  const { opts } = setup();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls > 1) return success();
    let reads = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("PRIVATE_PARTIAL_BODY"));
        else controller.error(reset());
      },
    }), { status: 200, headers: { "x-request-id": "provider-123" } });
  };
  const trace = newModelTrace("deepseek-v4-flash", opts.model);
  const report = await completeDigestStage(opts, { stage: "final", retryPrimary: false, fallbackModel: "deepseek-v4-flash", fallbackThinking: "disabled", fallbackMaxTokens: 8192 }, trace);
  assert.equal(report, "report"); assert.equal(calls, 2);
  assert.equal(trace.stages.final.retries, 0); assert.equal(trace.stages.final.fallbacks, 1);
  assert.equal(trace.stages.final.errors.length, 1);
  const e = trace.stages.final.errors[0]; assert.equal(e.attempt, 1); assert.equal(e.kind, "network");
  const d = e.diagnostics!; assert.equal(d.stage, "reading_body"); assert.equal(d.httpStatus, 200);
  assert.equal(d.receivedBytes, 20); assert.equal(d.receivedChunks, 1);
  assert.ok(d.lastByteMs !== undefined); assert.ok(d.idleMs !== undefined); assert.equal(d.providerRequestId, "provider-123");
  assert.equal(d.effectiveMaxTokens, 49152); noSecrets(trace);
});

test("success keeps wire parameters and result; broken observer never triggers retry", async () => {
  const { opts, get } = setup();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 49152); assert.equal(body.stream, undefined);
    assert.equal(init?.signal, undefined); assert.equal(body.thinking.type, "enabled");
    return success();
  };
  assert.equal(await complete(opts), "report");
  const d = get(); assert.equal(d.stage, "complete"); assert.equal(d.stream, false); assert.equal(d.appTimeoutMs, null);
  assert.equal(d.contentChars, 6); assert.equal(d.completionTokens, 20); assert.equal(d.finishReason, "stop");
  assert.equal(await complete({ ...opts, onDiagnostics: () => { throw new Error("observer"); } }), "report");
  assert.equal(calls, 2); noSecrets(d);
});

test("thinking-only stop retains actual usage below maximum and character units", async () => {
  const { opts, get } = setup();
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "PRIVATE_REASONING" }, finish_reason: "stop" }], usage: { prompt_tokens: 5905, completion_tokens: 16623 } }));
  await assert.rejects(complete(opts), /LLM 빈 응답/);
  const d = get(); assert.equal(d.stage, "validating_response"); assert.equal(d.finishReason, "stop");
  assert.equal(d.reasoningChars, 17); assert.equal(d.contentChars, 0); assert.equal(d.completionTokens, 16623); noSecrets(d);
});

test("HTTP errors and malformed JSON never echo provider body or hostile header", async () => {
  const { opts, get } = setup();
  globalThis.fetch = async () => new Response("PRIVATE_ARTICLE PRIVATE_API_KEY", { status: 429, headers: { "x-request-id": "Bearer PRIVATE_API_KEY" } });
  await assert.rejects(complete(opts), e => { assert.match(String(e), /LLM API 429/); noSecrets(String(e)); return true; });
  assert.equal(get().httpStatus, 429); assert.equal(get().providerRequestId, undefined); noSecrets(get());
  globalThis.fetch = async () => new Response("PRIVATE_BODY_NOT_JSON");
  await assert.rejects(complete(opts), /LLM invalid JSON response/);
  assert.equal(get().stage, "parsing_response"); noSecrets(get());
});

test("length response remains rejected, max budget is never increased by diagnostics", async () => {
  const { opts, get } = setup();
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "PRIVATE_PARTIAL" }, finish_reason: "length" }], usage: { completion_tokens: 49152 } }));
  await assert.rejects(complete(opts), /응답 잘림/);
  assert.equal(get().completionTokens, 49152); assert.equal(get().effectiveMaxTokens, 49152); noSecrets(get());
});

test("concurrent map failures retain their own attempt number", async () => {
  setup();
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");
  let rejectFirst!: (e: Error) => void;
  const first = completeDigestStage({ model: "deepseek-v4-flash", system: "", user: "" }, { stage: "map", retryPrimary: false }, trace,
    () => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  const firstFailure = assert.rejects(first, /first/);
  await assert.rejects(completeDigestStage({ model: "deepseek-v4-flash", system: "", user: "" }, { stage: "map", retryPrimary: false }, trace,
    async () => { throw new Error("second"); }), /second/);
  rejectFirst(new Error("first")); await firstFailure;
  assert.deepEqual(trace.stages.map.errors.map(e => e.attempt), [2, 1]);
});

test("diagnostic UI distinguishes unknown tokens from zero and supports legacy records", async () => {
  const { opts, get } = setup();
  globalThis.fetch = async () => { throw reset(); };
  await assert.rejects(complete(opts));
  const html = renderToStaticMarkup(createElement(LlmDiagnosticsPanel, { diagnostics: get(), runId: "dg-test" }));
  assert.match(html, /진단 정보 복사/); assert.match(html, /응답 헤더 대기/); assert.match(html, /수신 0바이트/);
  assert.match(html, /출력 확인 불가토큰/); assert.match(html, /ECONNRESET/); noSecrets(html);
  assert.match(renderToStaticMarkup(createElement(LlmDiagnosticsPanel, {})), /적용 후 새 실행부터/);
});
