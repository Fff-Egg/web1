import assert from "node:assert/strict";
import test from "node:test";
import { readChatCompletionStream } from "../src/server/analysis/chatCompletionStream.js";
import type { LlmCallDiagnostics } from "../src/shared/llmDiagnostics.js";

function probe(): LlmCallDiagnostics {
  return {
    version: 1, requestId: "stream-test", startedAt: "2026-09-09T05:00:33.000Z",
    durationMs: 0, stage: "reading_body", nodeVersion: process.version,
    stream: true, appTimeoutMs: null, systemChars: 0, userChars: 0,
    requestBytes: 0, receivedBytes: 0, receivedChunks: 0,
  };
}
async function* strings(values: string[]): AsyncGenerator<string> {
  yield* values;
}
function event(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

test("SSE handles split CRLF, CR, LF, comments, multiline JSON and Korean/emoji bytes", async () => {
  const source = ": keep-alive\r\n\r\n" +
    "event: message\rdata: {\rdata: \"choices\": [{\"index\":0,\"delta\":{\"reasoning_content\":\"PRIVATE_REASONING\"}}]}\r\r" +
    event({ content: "한국어 📈" }) +
    ": another keep-alive\n\n" +
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" 완성본\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":83,\"completion_tokens\":25}}\r\n\r\n" +
    "data: [DONE]\r\n\r\n";
  const encoded = new TextEncoder().encode(source);
  async function* decodedBytes(): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    for (const byte of encoded) yield decoder.decode(new Uint8Array([byte]), { stream: true });
    yield decoder.decode();
  }
  const diagnostics = probe();
  let time = 40;
  const result = await readChatCompletionStream(decodedBytes(), diagnostics, () => ++time);
  assert.deepEqual(result, {
    content: "한국어 📈 완성본", reasoningChars: "PRIVATE_REASONING".length,
    finishReason: "stop", usage: { prompt_tokens: 83, completion_tokens: 25 },
  });
  assert.equal(diagnostics.firstReasoningMs, 41);
  assert.equal(diagnostics.firstContentMs, 42);
  assert.equal(diagnostics.reasoningChars, "PRIVATE_REASONING".length);
  assert.equal(diagnostics.contentChars, result.content.length);
  assert.equal(diagnostics.promptTokens, 83);
  assert.equal(diagnostics.completionTokens, 25);
  assert.equal(diagnostics.streamCompleted, true);
  assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /PRIVATE_REASONING/);
});

test("DONE closes the source immediately and never consumes a later transport failure", async () => {
  let closed = false;
  async function* source(): AsyncGenerator<string> {
    try {
      yield event({ content: "complete" }, "stop") + "data: [DONE]\n\n";
      throw new Error("must not read after DONE");
    } finally { closed = true; }
  }
  assert.equal((await readChatCompletionStream(source(), probe(), () => 10)).content, "complete");
  assert.equal(closed, true);
});

test("reasoning and content counters survive a mid-stream reset, while partial output is rejected", async () => {
  const failure = new TypeError("terminated", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  async function* source(): AsyncGenerator<string> {
    yield event({ reasoning_content: "PRIVATE_REASONING" });
    yield event({ content: "PRIVATE_PARTIAL" });
    throw failure;
  }
  const diagnostics = probe();
  await assert.rejects(readChatCompletionStream(source(), diagnostics, () => 50), error => error === failure);
  assert.equal(diagnostics.stage, "reading_body");
  assert.equal(diagnostics.streamCompleted, false);
  assert.equal(diagnostics.reasoningChars, 17);
  assert.equal(diagnostics.contentChars, 15);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
});

test("EOF never promotes keepalives, partial content, or an unterminated DONE event to success", async () => {
  for (const source of [
    ": keep-alive\r\n\r\n: keep-alive\n\n",
    event({ content: "PRIVATE_PARTIAL" }),
    event({ content: "PRIVATE_PARTIAL" }, "stop"),
    event({ content: "PRIVATE_PARTIAL" }, "stop") + "data: [DONE]\n",
  ]) {
    const diagnostics = probe();
    await assert.rejects(readChatCompletionStream(strings([source]), diagnostics, () => 0), /stream terminated before \[DONE\]/);
    assert.equal(diagnostics.stage, "reading_body");
    assert.equal(diagnostics.streamCompleted, false);
  }
});

test("DONE requires a finish reason and never leaks accumulated content", async () => {
  const diagnostics = probe();
  await assert.rejects(
    readChatCompletionStream(strings([event({ content: "PRIVATE_PARTIAL" }), "data: [DONE]\n\n"]), diagnostics, () => 0),
    error => { assert.match(String(error), /missing finish reason/); assert.doesNotMatch(String(error), /PRIVATE_/); return true; },
  );
  assert.equal(diagnostics.stage, "parsing_response");
  assert.equal(diagnostics.streamCompleted, true);
});

test("malformed and provider error events have fixed errors without provider text", async () => {
  for (const source of [
    "data: PRIVATE_BAD_JSON\n\n",
    "data: null\n\n",
    'data: {"choices":[{"delta":{"content":{"PRIVATE_DATA":true}}}]}\n\n',
    'data: {"error":{"message":"PRIVATE_PROVIDER_MESSAGE","api_key":"PRIVATE_KEY"}}\n\n',
    "event: error\ndata: PRIVATE_PROVIDER_ERROR\n\n",
  ]) {
    const diagnostics = probe();
    await assert.rejects(readChatCompletionStream(strings([source]), diagnostics, () => 0), error => {
      assert.match(String(error), /LLM invalid SSE response/);
      assert.doesNotMatch(String(error), /PRIVATE_/);
      return true;
    });
    assert.equal(diagnostics.stage, "parsing_response");
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
  }
});

test("usage-only gateway chunk preserves zero counts and absent usage remains unknown", async () => {
  const source = event({ content: "complete" }, "stop");
  const diagnostics = probe();
  const result = await readChatCompletionStream(strings([
    source, 'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n', "data: [DONE]\n\n",
  ]), diagnostics, () => 0);
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(diagnostics.completionTokens, 0);
  const unknown = probe();
  const withoutUsage = await readChatCompletionStream(strings([source, "data: [DONE]\n\n"]), unknown, () => 0);
  assert.equal(withoutUsage.usage, undefined);
  assert.equal(unknown.completionTokens, undefined);
});

test("complete protocol returns non-stop reasons for the caller's shared validation", async () => {
  for (const reason of ["length", "content_filter", "insufficient_system_resource"]) {
    const diagnostics = probe();
    const result = await readChatCompletionStream(strings([
      event({ content: "partial" }, reason), "data: [DONE]\n\n",
    ]), diagnostics, () => 0);
    assert.equal(result.finishReason, reason);
    assert.equal(diagnostics.finishReason, reason);
  }
});
