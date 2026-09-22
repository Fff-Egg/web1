import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { readWholeArticle, READING_RECOVERY_MAX_CALLS, READING_REQUEST_CHARS } from "../src/server/analysis/fullReading.js";
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
      if (part.length > 3000) throw limit();
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
  assert.equal(calls, 3);
  assert.equal(saved?.recovery?.held?.reason, "output_limit");
  assert.equal(saved?.completedAt, undefined); assert.equal(saved?.text, undefined);
  assert.deepEqual(saved?.chunks, {});
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", cache: saved,
    invoke: async () => { calls++; return "must not call"; } }), WholeReadingHeldError);
  assert.equal(calls, 3);
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
  assert.deepEqual(sizes, [6000, 3000, 1500]);
});

test("adaptive call budget persists across invocations; exhausted budget makes no extra request", async () => {
  const body = "A".repeat(6000) + "B".repeat(6000) + "C".repeat(1000);
  let saved: ReadingCache | undefined;
  const checkpoint = async (cache: ReadingCache) => { saved = structuredClone(cache); };
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint, invoke: async call => {
    if (input(call).length >= 6000) throw limit();
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
  const completeCache = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled",
    invoke: async () => "요약" });
  // Captured from production HEAD 3b64787 before the adaptive recovery change.
  const expectedLegacyKey = "d7ea0a6ae9c90123faed6d188eee5c676b42511674fcf37d7393ba0afe85c1b9";
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

test("internal fact reading excludes Feed presentation instructions and bounds every first request without dropping source text", async () => {
  const body = Array.from({ length: 100 }, (_, i) => `사건 ${i}: 주체 회사${i}, 가격 ${i + 10}원, 날짜 9월 22일. ${"조건·반론·결론 ".repeat(20)}\n`).join("") + "마지막 별개 사건 TAIL_EVENT 🚀";
  const instructions = "CUSTOM_FEED_GUIDE: 2~5문장; 직접 영향·2차·3차 연결 가설과 검증 데이터를 각 사건마다 작성한다. 모든 사건을 보존한다.";
  const seen: string[] = [];
  let checkpoint: ReadingCache | undefined;
  const result = await readWholeArticle({ body, instructions, model: "deepseek-flash", thinking: "disabled",
    checkpoint: async cache => { checkpoint = structuredClone(cache); },
    invoke: async call => {
      const part = input(call);
      assert.ok(part.length <= READING_REQUEST_CHARS);
      assert.equal(call.maxTokens, 3200);
      assert.equal(call.thinking, "disabled");
      assert.doesNotMatch(call.system, /CUSTOM_FEED_GUIDE|사용자 요약 지침|2000자/);
      assert.match(call.system, /서로 다른 사건·주장은 각각 짧은 한 줄/);
      assert.match(call.system, /새로운 투자 해석/);
      assert.match(call.system, /원문에 있는 영향·가설·검증 조건은 보존/);
      assert.equal(checkpoint?.recovery?.policy, 2);
      seen.push(part);
      return `완료된 구간 ${seen.length}`;
    },
  });
  assert.equal(seen.join(""), body);
  assert.match(seen.at(-1)!, /TAIL_EVENT 🚀/);
  assert.equal(result.recovery?.calls, 0, "planned input chunks must not spend the corrective-call allowance");
  assert.ok(Object.keys(result.recovery!.proactiveSplits!).length > 0);
  assert.ok(result.completedAt);
});

test("policy migration releases a legacy held reading once and reuses its successful child without retrying rejected parents", async () => {
  const body = "원문".repeat(7000);
  const first = splitWholeText(body)[0];
  const parentKey = hash(`0:0:2:${first}`);
  const childKey = hash(`recovery-v1:${parentKey}:0:${first.slice(0, 6000)}`);
  const legacy: ReadingCache = { version: 1,
    key: "d7ea0a6ae9c90123faed6d188eee5c676b42511674fcf37d7393ba0afe85c1b9",
    chunks: { [childKey]: "이미 완료된 첫 자식 사실" }, inputChars: body.length, chunkCount: 2,
    recovery: { version: 1, splits: { [parentKey]: true }, calls: 24,
      held: { reason: "recovery_budget", at: "2026-09-22T00:00:00.000Z" } },
  };
  const requested: string[] = [];
  let saved: ReadingCache | undefined;
  const result = await readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled", cache: legacy,
    checkpoint: async c => { saved = structuredClone(c); }, invoke: async call => {
      assert.equal(saved?.recovery?.policy, 2);
      assert.equal(saved?.recovery?.held, undefined);
      requested.push(input(call)); return "나머지 사실";
    },
  });
  assert.deepEqual(requested, [first.slice(6000), body.slice(12000)]);
  assert.match(result.text!, /이미 완료된 첫 자식 사실/);
  assert.equal(result.recovery?.calls, 1);
  assert.equal(result.key, legacy.key);
  assert.equal(legacy.recovery?.calls, 24, "caller cache is not mutated");
  assert.ok(legacy.recovery?.held);

  const heldAgain = { ...result, completedAt: undefined, text: undefined, recovery: {
    ...result.recovery!, held: { reason: "output_limit" as const, at: "2026-09-22T01:00:00.000Z" },
  } };
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", thinking: "disabled", cache: heldAgain,
    invoke: async () => { throw Error("new-policy hold must not reopen automatically"); } }), WholeReadingHeldError);
});

test("explicit reset retains proactive plans and policy while renewing only corrective allowance", async () => {
  const cache: ReadingCache = { version: 1, key: "key", chunks: { done: "completed facts" }, inputChars: 13000, chunkCount: 2,
    recovery: { version: 1, policy: 2, splits: { planned: true, failed: true }, proactiveSplits: { planned: true }, calls: 24,
      held: { reason: "recovery_budget", at: "2026-09-22T00:00:00.000Z" } },
  };
  const reset = resetReadingRecovery(cache)!;
  assert.equal(reset.recovery?.policy, 2);
  assert.deepEqual(reset.recovery?.proactiveSplits, { planned: true });
  assert.deepEqual(reset.recovery?.splits, cache.recovery?.splits);
  assert.deepEqual(reset.chunks, cache.chunks);
  assert.equal(reset.recovery?.calls, 0);
  assert.equal(reset.recovery?.held, undefined);
  assert.ok(cache.recovery?.held);
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
