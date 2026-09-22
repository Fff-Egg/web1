import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { readWholeArticle, READING_RECOVERY_MAX_CALLS } from "../src/server/analysis/fullReading.js";
import { complete, type CompleteOpts } from "../src/server/analysis/anthropic.js";
import { LlmOutputLimitError, WholeReadingHeldError } from "../src/server/analysis/llmErrors.js";
import { withLlmUsageSink } from "../src/server/analysis/usageObservation.js";
import { resetReadingRecovery, splitWholeText, type ReadingCache } from "../src/shared/articleContent.js";

const originalFetch = globalThis.fetch;
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY"] as const;
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeEach(() => {
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_EXTRA_BODY;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});
const input = (call: CompleteOpts) => call.user.slice(call.user.indexOf("\n\n") + 2);
const limit = () => new LlmOutputLimitError("LLM 응답 잘림 (finish_reason=length)");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("length response splits losslessly including emoji; persists plan before children and caches complete result", async () => {
  const body = "A".repeat(11999) + "🚀" + "\n\n" + "끝".repeat(5000);
  let saved: ReadingCache | undefined;
  const successful: string[] = [];
  let calls = 0;
  const result = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled",
    checkpoint: async cache => { saved = structuredClone(cache); },
    invoke: async call => {
      calls++;
      assert.equal(call.maxTokens, 3200); assert.equal(call.thinking, "disabled");
      const part = input(call);
      if (part.length > 6000) throw limit();
      if (call.user.includes("재분할")) {
        assert.ok(saved?.recovery && Object.keys(saved.recovery.splits).length > 0);
        assert.ok(saved.recovery.calls > 0);
      }
      assert.doesNotMatch(part, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      successful.push(part);
      return `사실 메모 ${successful.length}`;
    },
  });
  assert.equal(successful.join(""), body);
  assert.ok(result.completedAt); assert.equal(result.recovery?.held, undefined);
  assert.ok(calls > splitWholeText(body).length);
  await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled", cache: result,
    invoke: async () => { throw Error("completed reading must not call API"); } });
});

test("a later failed child resumes without retrying rejected parent or successful sibling", async () => {
  const body = "A".repeat(6000) + "B".repeat(6000) + "C".repeat(1000);
  let saved: ReadingCache | undefined;
  const checkpoint = async (cache: ReadingCache) => { saved = structuredClone(cache); };
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint, invoke: async call => {
    const part = input(call);
    if (part.length > 6000) throw limit();
    if (part.startsWith("B")) throw Error("temporary connection failure");
    return "A 구간의 완료된 사실";
  } }), /temporary connection/);
  assert.ok(saved?.recovery?.splits); assert.equal(saved?.completedAt, undefined);
  const resumed: string[] = [];
  const result = await readWholeArticle({ body, model: "deepseek-flash", cache: saved, checkpoint,
    invoke: async call => { resumed.push(input(call)); return "다음 구간의 사실"; } });
  assert.deepEqual(resumed, ["B".repeat(6000), "C".repeat(1000)]);
  assert.match(result.text!, /A 구간의 완료된 사실/); assert.ok(result.completedAt);
});

test("exhausted smallest chunk is held across polls until explicit retry; reset preserves split plan", async () => {
  const body = "원".repeat(13000);
  let saved: ReadingCache | undefined, calls = 0;
  const checkpoint = async (cache: ReadingCache) => { saved = structuredClone(cache); };
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint,
    invoke: async () => { calls++; throw limit(); } }), WholeReadingHeldError);
  assert.equal(calls, 4);
  assert.equal(saved?.recovery?.held?.reason, "output_limit");
  assert.equal(saved?.completedAt, undefined); assert.equal(saved?.text, undefined);
  assert.deepEqual(saved?.chunks, {});
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", cache: saved,
    invoke: async () => { calls++; return "must not call"; } }), WholeReadingHeldError);
  assert.equal(calls, 4);
  const reset = resetReadingRecovery(saved)!;
  assert.equal(reset.recovery?.calls, 0); assert.equal(reset.recovery?.held, undefined);
  assert.deepEqual(reset.recovery?.splits, saved!.recovery!.splits);
  const retryInputs: string[] = [];
  const result = await readWholeArticle({ body, model: "deepseek-flash", cache: reset, checkpoint,
    invoke: async call => { retryInputs.push(input(call)); return "완료된 사실"; } });
  assert.equal(retryInputs[0].length, 1500); // Skip all failed ancestors.
  assert.ok(result.completedAt);
});

test("paragraph boundaries cannot create prematurely tiny recovery children", async () => {
  const body = "A".repeat(1000) + "\n" + "B".repeat(2499) + "\n" + "C".repeat(9500);
  const sizes: number[] = [];
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", invoke: async call => {
    sizes.push(input(call).length); throw limit();
  } }), WholeReadingHeldError);
  assert.deepEqual(sizes, [12000, 6000, 3000, 1500]);
});

test("adaptive call budget persists across invocations; exhausted budget makes no extra request", async () => {
  const body = "A".repeat(6000) + "B".repeat(6000) + "C".repeat(1000);
  let saved: ReadingCache | undefined;
  const checkpoint = async (cache: ReadingCache) => { saved = structuredClone(cache); };
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint, invoke: async call => {
    if (input(call).length > 6000) throw limit();
    throw Error("connection failure");
  } }), /connection failure/);
  assert.ok(saved?.recovery);
  saved!.recovery!.calls = READING_RECOVERY_MAX_CALLS;
  let calls = 0;
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", cache: saved, checkpoint,
    invoke: async () => { calls++; return "no"; } }), WholeReadingHeldError);
  assert.equal(calls, 0); assert.equal(saved!.recovery!.held?.reason, "recovery_budget");
});

test("legacy key and successful checkpoints are preserved without global re-reading", async () => {
  const body = "원문".repeat(7000);
  let firstCall: CompleteOpts | undefined;
  const completeCache = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled",
    invoke: async call => { firstCall ??= call; return "요약"; } });
  const expectedLegacyKey = hash(JSON.stringify([1, body, "수집 범위 미확인", "deepseek-flash", "disabled", firstCall!.system, 12000]));
  // Captured from production HEAD 3b64787 before the adaptive recovery change.
  assert.equal(expectedLegacyKey, "d7ea0a6ae9c90123faed6d188eee5c676b42511674fcf37d7393ba0afe85c1b9");
  assert.equal(completeCache.key, expectedLegacyKey);
  const legacyComplete = structuredClone(completeCache); delete legacyComplete.recovery;
  const reused = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled", cache: legacyComplete,
    invoke: async () => { throw Error("legacy complete cache was invalidated"); } });
  assert.deepEqual(reused, legacyComplete);
  const firstChunk = splitWholeText(body)[0];
  const partial: ReadingCache = { version: 1, key: expectedLegacyKey,
    chunks: { [hash(`0:0:2:${firstChunk}`)]: "옛 완료 구간" }, inputChars: body.length, chunkCount: 2 };
  let calls = 0;
  const resumed = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled", cache: partial,
    invoke: async () => { calls++; return "나머지"; } });
  assert.equal(calls, 1); assert.match(resumed.text!, /옛 완료 구간/);
});

test("changed reading instructions release a held cache, without treating it as completed", async () => {
  const body = "원".repeat(13000);
  let saved: ReadingCache | undefined;
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint: async c => { saved = structuredClone(c); },
    invoke: async () => { throw limit(); } }), WholeReadingHeldError);
  let calls = 0;
  const result = await readWholeArticle({ body, model: "deepseek-flash", instructions: "수치와 조건 위주로 간결하게", cache: saved,
    invoke: async () => { calls++; return "완료"; } });
  assert.ok(calls > 0); assert.ok(result.completedAt); assert.notEqual(result.key, saved!.key);
});

test("transport returns typed output-limit errors while still recording consumed tokens", async () => {
  let recorded = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "rejected partial" }, finish_reason: "length" }], usage: { completion_tokens: 3200 } }));
  await withLlmUsageSink(event => { recorded += event.outputTokens ?? 0; assert.equal(event.success, false); },
    () => assert.rejects(complete({ model: "deepseek-flash", system: "", user: "", maxTokens: 3200, thinking: "disabled" }), LlmOutputLimitError));
  assert.equal(recorded, 3200);
});
