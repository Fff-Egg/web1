import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { classifyDigestFailure } from "../src/server/digest/modelPipeline.js";
import { analysisFailureReason, globalPauseMinutes } from "../src/server/analysis/retryPolicy.js";
import { isLlmOutputLimitError } from "../src/server/analysis/llmErrors.js";
import { isAutomaticAnalysisPeakAvoidanceEnabled, shouldDeferAutomaticAnalysis } from "../src/server/analysis/schedule.js";
import { articleReadingPacketBudget, CLAUDE_READING_PACKET_BYTES } from "../src/server/repo/articleContent.js";
import {
  claudeThinkingRequest,
  hasMillionTokenContext,
  isLegacyClaudeModel,
  parseClaudeEffort,
  supportsServerFallback,
} from "../src/server/analysis/claudeModels.js";
import type { LlmCallDiagnostics } from "../src/shared/llmDiagnostics.js";

/**
 * Claude API path against a local stand-in for POST /v1/messages (SSE). The real SDK
 * builds and parses every request, so these tests cover the wire shape, not a mock.
 */
type Reply =
  | { kind: "message"; text?: string; stopReason: string; model?: string; stopDetails?: unknown; thinkingOnly?: boolean }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "streamError"; errorType: string };
interface Seen { url: string; beta: string | undefined; body: Record<string, unknown> }

const replies: Reply[] = [];
const seen: Seen[] = [];
let server: Server;

function sse(res: import("node:http").ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

before(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const beta = req.headers["anthropic-beta"];
    seen.push({ url: req.url ?? "", beta: Array.isArray(beta) ? beta.join(",") : beta, body });
    const reply = replies.shift() ?? { kind: "message", text: "기본 응답", stopReason: "end_turn" };
    if (reply.kind === "http") {
      res.writeHead(reply.status, { "content-type": "application/json", "request-id": "req_test" });
      res.end(JSON.stringify(reply.body));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
    const model = reply.kind === "message" ? reply.model ?? String(body.model) : String(body.model);
    sse(res, "message_start", { type: "message_start", message: {
      id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 30 },
    } });
    if (reply.kind === "streamError") {
      sse(res, "error", { type: "error", error: { type: reply.errorType, message: "temporarily unavailable" } });
      res.end();
      return;
    }
    if (reply.thinkingOnly) {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    } else if (reply.text !== undefined) {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    }
    sse(res, "message_delta", { type: "message_delta",
      delta: { stop_reason: reply.stopReason, stop_sequence: null, stop_details: reply.stopDetails ?? null },
      usage: { output_tokens: 42 } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // DeepSeek variables stay in place: LLM_PROVIDER alone must switch the provider.
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "deepseek-test";
  process.env.LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  delete process.env.FILTER_MODEL;
  delete process.env.ANALYSIS_MODEL;
  delete process.env.CLAUDE_THINKING_EFFORT;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const llm = () => import("../src/server/analysis/anthropic.js");
const last = () => seen[seen.length - 1];

test("LLM_PROVIDER=anthropic switches over even with DeepSeek variables left in place", async () => {
  const { llmProvider, hasLLM, resolveModel, FILTER_MODEL, ANALYSIS_MODEL, supportsThinkingControl } = await llm();
  assert.equal(llmProvider(), "anthropic");
  assert.equal(hasLLM(), true);
  // Saved Settings from the DeepSeek era keep their tier instead of 404ing.
  assert.equal(resolveModel("deepseek-flash"), "claude-haiku-5-5");
  assert.equal(resolveModel("deepseek-v4-flash"), "claude-haiku-5-5");
  assert.equal(resolveModel("deepseek-v4-pro"), "claude-opus-5-5");
  assert.equal(resolveModel("deepseek-reasoner"), "claude-opus-5-5");
  assert.equal(resolveModel(" claude-sonnet-5-5 "), "claude-sonnet-5-5");
  assert.equal(FILTER_MODEL(), "claude-haiku-5-5");
  assert.equal(ANALYSIS_MODEL(), "claude-opus-5-5");
  process.env.FILTER_MODEL = "deepseek-v4-flash";
  assert.equal(FILTER_MODEL(), "claude-haiku-5-5");
  delete process.env.FILTER_MODEL;
  assert.equal(supportsThinkingControl("deepseek-flash"), true);
  assert.equal(supportsThinkingControl("claude-haiku-4-5-20251001"), false);

  delete process.env.LLM_PROVIDER;
  assert.equal(llmProvider(), "openai-compatible", "unset switch keeps the DeepSeek deployment as it was");
  assert.equal(resolveModel("deepseek-flash"), "deepseek-flash");
  process.env.LLM_PROVIDER = "anthropic";
});

test("Claude has no peak-price wait; the 1M-context packet budget applies to mapped DeepSeek ids", () => {
  assert.equal(isAutomaticAnalysisPeakAvoidanceEnabled(), false);
  assert.equal(shouldDeferAutomaticAnalysis(new Date("2026-08-25T11:00:00+09:00")), false);
  const cfg = { instructions: "x", filterModel: "deepseek-flash", digestMapModel: "deepseek-flash", analysisModel: "deepseek-v4-pro" };
  assert.deepEqual(articleReadingPacketBudget(cfg), { maxBytes: CLAUDE_READING_PACKET_BYTES });
  assert.deepEqual(articleReadingPacketBudget({ ...cfg, filterModel: "claude-haiku-4-5" }), { maxChars: 12000 });
});

test("filter-style call: Haiku with thinking off, cached system prompt, tokenizer allowance", async () => {
  const { complete } = await llm();
  let diagnostics: LlmCallDiagnostics | undefined;
  replies.push({ kind: "message", text: '{"relevant": true}', stopReason: "end_turn" });
  const text = await complete({ model: "deepseek-flash", system: "지침", user: "본문", maxTokens: 1600, thinking: "disabled",
    responseFormat: "json_object", onDiagnostics: (d) => { diagnostics = d; } });
  assert.equal(text, '{"relevant": true}');
  const { body, beta, url } = last();
  assert.match(url, /^\/v1\/messages/);
  assert.equal(beta, undefined, "Haiku has no server-side fallback");
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2400);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.output_config, undefined);
  assert.equal(body.temperature, undefined, "sampling parameters 400 on current models");
  assert.equal(body.response_format, undefined);
  assert.deepEqual(body.system, [{ type: "text", text: "지침", cache_control: { type: "ephemeral" } }]);
  assert.equal(diagnostics?.endpointHost, "api.anthropic.com");
  assert.equal(diagnostics?.effectiveThinking, "disabled");
  assert.equal(diagnostics?.promptTokens, 2150);
  assert.equal(diagnostics?.cacheHitTokens, 2000);
  assert.equal(diagnostics?.cacheMissTokens, 150);
  assert.equal(diagnostics?.completionTokens, 42);
  assert.equal(diagnostics?.finishReason, "end_turn");
  assert.equal(diagnostics?.providerRequestId, "req_test");
});

test("Opus 5.5 cannot turn thinking off: low effort, extra headroom and the refusal fallback opt-in", async () => {
  const { complete } = await llm();
  replies.push({ kind: "message", text: "학습 메모", stopReason: "end_turn" });
  await complete({ model: "claude-opus-5-5", system: "s", user: "u", maxTokens: 700, thinking: "disabled" });
  const { body, beta, url } = last();
  assert.match(url, /beta=true/);
  assert.match(beta ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(body.fallbacks, "default");
  assert.equal(body.thinking, undefined, "disabled thinking is a 400 on this model");
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.max_tokens, 1050 + 16384);

  replies.push({ kind: "message", text: "보고서", stopReason: "end_turn" });
  await complete({ model: "claude-opus-5-5", system: "s", user: "u", maxTokens: 49152, thinking: "enabled" });
  assert.deepEqual(last().body.thinking, { type: "adaptive" });
  assert.deepEqual(last().body.output_config, { effort: "high" });
  assert.equal(last().body.max_tokens, 49152, "thinking budgets are already sized");
});

test("a cut-off answer is never returned: max_tokens becomes the typed output-limit error", async () => {
  const { complete } = await llm();
  replies.push({ kind: "message", text: "중간에서 끊긴", stopReason: "max_tokens" });
  const error = await complete({ model: "claude-haiku-5-5", system: "s", user: "u", maxTokens: 100, thinking: "disabled" })
    .then(() => null, (e: unknown) => e);
  assert.ok(isLlmOutputLimitError(error));
  assert.match(String((error as Error).message), /finish_reason=length/);
  assert.equal(classifyDigestFailure(error), "token_limit");
  assert.equal(analysisFailureReason(error), "output_limit");
});

test("refusals and empty answers throw instead of saving nothing", async () => {
  const { complete } = await llm();
  replies.push({ kind: "message", stopReason: "refusal", stopDetails: { type: "refusal", category: "bio", explanation: null } });
  const refusal = await complete({ model: "claude-haiku-5-5", system: "s", user: "u", thinking: "disabled" }).then(() => null, (e: unknown) => e);
  assert.match(String((refusal as Error).message), /stop_reason=refusal category=bio/);
  assert.equal(classifyDigestFailure(refusal), "content_filter");
  assert.equal(analysisFailureReason(refusal), "request_rejected");

  replies.push({ kind: "message", stopReason: "end_turn", thinkingOnly: true });
  const empty = await complete({ model: "claude-haiku-5-5", system: "s", user: "u", thinking: "enabled", maxTokens: 49152 }).then(() => null, (e: unknown) => e);
  assert.match(String((empty as Error).message), /LLM 빈 응답/);
});

test("exhausted monthly credits pause analysis like a DeepSeek balance error", async () => {
  const { complete } = await llm();
  replies.push({ kind: "http", status: 400, body: { type: "error", error: { type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } } });
  let diagnostics: LlmCallDiagnostics | undefined;
  const error = await complete({ model: "claude-haiku-5-5", system: "s", user: "u", thinking: "disabled",
    onDiagnostics: (d) => { diagnostics = d; } }).then(() => null, (e: unknown) => e);
  assert.match(String((error as Error).message), /^LLM API 400: provider request failed \(balance\)/);
  assert.doesNotMatch(String((error as Error).message), /credit balance/, "provider text is not retained");
  assert.equal(analysisFailureReason(error), "balance");
  assert.equal(globalPauseMinutes("balance"), 60);
  assert.equal(diagnostics?.httpStatus, 400);
  assert.equal(diagnostics?.errorCategory, "balance");
});

test("an overload error inside an open stream is a retryable provider error", async () => {
  const { complete } = await llm();
  replies.push({ kind: "streamError", errorType: "overloaded_error" });
  const error = await complete({ model: "claude-haiku-5-5", system: "s", user: "u", thinking: "disabled" }).then(() => null, (e: unknown) => e);
  assert.match(String((error as Error).message), /^LLM API 529:/);
  assert.equal(classifyDigestFailure(error), "provider_5xx");
  assert.equal(analysisFailureReason(error), "transient");
});

test("if the fallback beta is rejected, the same call goes out once without it and later calls skip it", async () => {
  const { complete } = await llm();
  replies.push({ kind: "http", status: 400, body: { type: "error", error: { type: "invalid_request_error",
    message: "Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header." } } });
  replies.push({ kind: "message", text: "보고서", stopReason: "end_turn" });
  const before = seen.length;
  assert.equal(await complete({ model: "claude-opus-5-5", system: "s", user: "u", thinking: "enabled", maxTokens: 49152 }), "보고서");
  assert.equal(seen.length - before, 2);
  assert.equal(seen[before + 1].body.fallbacks, undefined);
  replies.push({ kind: "message", text: "다음", stopReason: "end_turn" });
  await complete({ model: "claude-opus-5-5", system: "s", user: "u", thinking: "enabled", maxTokens: 49152 });
  assert.equal(last().beta, undefined);
});

test("thinking translation follows each model generation's rules", () => {
  assert.deepEqual(claudeThinkingRequest("claude-haiku-5-5", "disabled"),
    { thinking: { type: "disabled" }, effectiveThinking: "disabled", needsHeadroom: false });
  assert.deepEqual(claudeThinkingRequest("claude-haiku-5-5", "enabled", "medium"),
    { thinking: { type: "adaptive" }, effort: "medium", effectiveThinking: "enabled", needsHeadroom: false });
  assert.deepEqual(claudeThinkingRequest("claude-sonnet-5-5", "disabled"),
    { thinking: { type: "between_tools" }, effectiveThinking: "disabled", needsHeadroom: false });
  assert.deepEqual(claudeThinkingRequest("claude-opus-5-5", "disabled"),
    { effort: "low", effectiveThinking: "enabled", needsHeadroom: true });
  assert.deepEqual(claudeThinkingRequest("claude-haiku-4-5-20251001", "enabled"),
    { effectiveThinking: "disabled", needsHeadroom: false });
  assert.equal(claudeThinkingRequest("claude-opus-5", undefined).needsHeadroom, true);
  assert.equal(isLegacyClaudeModel("claude-sonnet-4-5-20250929"), true);
  assert.equal(isLegacyClaudeModel("claude-opus-4-20250514"), true);
  assert.equal(isLegacyClaudeModel("claude-opus-4-8"), false);
  assert.equal(supportsServerFallback("claude-opus-5-5"), true);
  assert.equal(supportsServerFallback("claude-haiku-5-5"), false);
  assert.equal(hasMillionTokenContext("claude-haiku-5-5"), true);
  assert.equal(hasMillionTokenContext("claude-haiku-4-5"), false);
  assert.equal(parseClaudeEffort(" Medium "), "medium");
  assert.equal(parseClaudeEffort("extreme"), "high");
  assert.equal(parseClaudeEffort(undefined), "high");
});
