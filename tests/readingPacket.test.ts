import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { readWholeArticle, readCachedSourceNotes, type ReadingPacketBudget } from "../src/server/analysis/fullReading.js";
import { articleReadingPacketBudget, DEEPSEEK_READING_PACKET_BYTES } from "../src/server/repo/articleContent.js";
import { resetReadingRecovery, splitWholeText, type ReadingCache } from "../src/shared/articleContent.js";
import { WholeReadingHeldError } from "../src/server/analysis/llmErrors.js";
import type { CompleteOpts } from "../src/server/analysis/anthropic.js";

const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY", "LLM_MODEL", "FILTER_MODEL", "ANALYSIS_MODEL"] as const;
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => {
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "mock-only";
  for (const key of keys.slice(2)) delete process.env[key];
});
afterEach(() => { for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } });
const packetBudget = { maxBytes: DEEPSEEK_READING_PACKET_BYTES };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const input = (call: CompleteOpts) => call.user.slice(call.user.indexOf("\n\n") + 2);
const compact = (call: CompleteOpts) => call.system.includes("이미 전체 원문을 읽어 만든 사실 메모");
const cfg = { instructions: "전체 읽기", filterModel: "deepseek-flash", digestMapModel: "deepseek-flash", analysisModel: "deepseek-flash" };

test("large note budget is explicit and only enabled for every known official Flash consumer", () => {
  assert.deepEqual(articleReadingPacketBudget(cfg), packetBudget);
  for (const model of ["custom-flash", "deepseek-v4.1-flash", "claude-other"]) {
    assert.deepEqual(articleReadingPacketBudget({ ...cfg, filterModel: model }), { maxChars: 12000 });
    assert.deepEqual(articleReadingPacketBudget({ ...cfg, digestMapModel: model }), { maxChars: 12000 });
    assert.deepEqual(articleReadingPacketBudget({ ...cfg, analysisModel: model }), { maxChars: 12000 });
  }
  process.env.LLM_BASE_URL = "https://proxy.example.com";
  assert.deepEqual(articleReadingPacketBudget(cfg), { maxChars: 12000 });
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_EXTRA_BODY = JSON.stringify({ model: "unknown-wire-model" });
  assert.deepEqual(articleReadingPacketBudget(cfg), { maxChars: 12000 });
  process.env.LLM_EXTRA_BODY = JSON.stringify({ model: "deepseek-flash" });
  assert.deepEqual(articleReadingPacketBudget({ ...cfg, analysisModel: "stale-custom-model" }), packetBudget);
  delete process.env.LLM_EXTRA_BODY;
  delete process.env.LLM_API_KEY;
  assert.deepEqual(articleReadingPacketBudget(cfg), { maxChars: 12000 });
});

test("64k near-identity notes finish after one full source pass with zero repeated compaction", async () => {
  const body = "원".repeat(64000), seen: string[] = [];
  const result = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, invoke: async call => {
    assert.equal(compact(call), false);
    const part = input(call); seen.push(part); return part;
  } });
  assert.equal(seen.join(""), body); assert.equal(seen.length, 11);
  assert.ok(result.completedAt); assert.ok(result.text!.length > 12000);
  assert.ok(Buffer.byteLength(result.text!) <= packetBudget.maxBytes);
  assert.equal(readCachedSourceNotes(body, result), result.text);
  await readWholeArticle({ body, model: "deepseek-flash", packetBudget, cache: result,
    invoke: async () => { throw Error("complete source reading should be reused"); } });
});

test("generic near-identity output gets only one new consolidation pass instead of twelve rewrite levels", async () => {
  const body = "원".repeat(64000);
  let sourceCalls = 0, compactCalls = 0, saved: ReadingCache | undefined;
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint: async c => { saved = structuredClone(c); },
    invoke: async call => { if (compact(call)) compactCalls++; else sourceCalls++; return input(call).slice(0, -50); },
  }), WholeReadingHeldError);
  assert.equal(sourceCalls, 11); assert.ok(compactCalls > 0 && compactCalls <= 12);
  assert.equal(saved?.recovery?.held?.reason, "packet_too_large");
  assert.equal(saved?.completedAt, undefined); assert.equal(saved?.text, undefined);
  assert.ok(readCachedSourceNotes(body, saved));
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", cache: saved,
    invoke: async () => { throw Error("current hold must not reopen automatically"); } }), WholeReadingHeldError);
});

test("legacy size holds reopen only explicitly and all completed source notes are then reused for free", async () => {
  const body = "원".repeat(64000);
  const result = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, invoke: async call => input(call) });
  for (const reason of ["not_compressed", "too_many_levels", "recovery_budget"] as const) {
    const held = structuredClone(result);
    delete held.completedAt; delete held.text;
    held.recovery!.held = { reason, at: "2026-09-22T10:15:06Z" };
    await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", packetBudget, cache: held,
      invoke: async () => { throw Error("held input cannot call"); } }), WholeReadingHeldError);
    const resumed = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, cache: resetReadingRecovery(held),
      invoke: async () => { throw Error("all original source roots were already read"); } });
    assert.ok(resumed.completedAt); assert.equal(resumed.key, result.key); assert.equal(resumed.text, result.text);
    assert.deepEqual(resumed.chunks, result.chunks);
  }
});

test("completed packet reuse checks UTF8 bytes and a stricter consumer budget without re-reading original source", async () => {
  const body = "한".repeat(13000);
  const large = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, invoke: async call => input(call) });
  const narrow = { maxBytes: 20000 };
  assert.ok(large.text!.length < narrow.maxBytes); assert.ok(Buffer.byteLength(large.text!) > narrow.maxBytes);
  let compactCalls = 0;
  const smaller = await readWholeArticle({ body, model: "deepseek-flash", packetBudget: narrow, cache: large,
    invoke: async call => { assert.ok(compact(call)); compactCalls++; return "핵심 사건과 수치, 조건 및 반론"; } });
  assert.ok(compactCalls > 0); assert.ok(smaller.completedAt); assert.ok(Buffer.byteLength(smaller.text!) <= narrow.maxBytes);
  assert.equal(smaller.key, large.key);
  for (const [key, value] of Object.entries(large.chunks)) assert.equal(smaller.chunks[key], value);
  assert.notEqual(smaller.text, large.text);
});

test("historical shorter complete levels can fit a narrower packet with no new request", async () => {
  const body = "原".repeat(64000);
  const source = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, invoke: async call => input(call) });
  const partial = structuredClone(source);
  const firstPass = partial.text!;
  delete partial.completedAt; delete partial.text;
  const parts = splitWholeText(firstPass);
  parts.forEach((part, i) => { partial.chunks[hash(`1:${i}:${parts.length}:${part}`)] = `이미 완료된 옛 압축 ${i}`; });
  partial.chunks.arbitrary = "MUST_NOT_BE_CONCATENATED";
  const result = await readWholeArticle({ body, model: "deepseek-flash", cache: partial,
    invoke: async () => { throw Error("complete historical reduction should be reused"); } });
  assert.ok(result.completedAt); assert.ok(result.text!.length <= 12000);
  assert.match(result.text!, /이미 완료된 옛 압축/); assert.doesNotMatch(result.text!, /MUST_NOT_BE_CONCATENATED/);
  assert.equal(readCachedSourceNotes(body, result), firstPass);
});

test("interrupted single consolidation resumes its successful chunks and never reruns source reading", async () => {
  const body = "원".repeat(64000);
  let saved: ReadingCache | undefined, compactCalls = 0;
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", checkpoint: async c => { saved = structuredClone(c); },
    invoke: async call => {
      if (!compact(call)) return input(call);
      if (++compactCalls === 2) throw Error("temporary interruption");
      return "FIRST_COMPACT_SUCCESS";
    },
  }), /temporary interruption/);
  let resumed = 0;
  const result = await readWholeArticle({ body, model: "deepseek-flash", cache: saved,
    invoke: async call => { assert.ok(compact(call)); resumed++; return "나머지 압축 사실"; } });
  assert.ok(result.completedAt); assert.match(result.text!, /FIRST_COMPACT_SUCCESS/);
  assert.ok(resumed > 0); assert.ok(readCachedSourceNotes(body, result));
});

test("interrupted narrowing retains the previously completed packet and its paid new chunks", async () => {
  const body = "원".repeat(64000);
  const large = await readWholeArticle({ body, model: "deepseek-flash", packetBudget: { maxChars: 50000 },
    invoke: async call => compact(call) ? "Z".repeat(2000) : input(call) });
  assert.ok(large.completedAt); assert.ok(large.text!.length > 12000 && large.text!.length < 50000);
  const paidInputs: string[] = [];
  let saved: ReadingCache | undefined;
  await assert.rejects(readWholeArticle({ body, model: "deepseek-flash", cache: large,
    checkpoint: async cache => { saved = structuredClone(cache); },
    invoke: async call => {
      assert.ok(compact(call)); paidInputs.push(input(call));
      if (paidInputs.length === 2) throw Error("narrowing interruption");
      return "FIRST_NARROW_SUCCESS";
    } }), /narrowing interruption/);
  assert.equal(saved?.completedAt, undefined); assert.equal(saved?.text, undefined);
  assert.equal(saved?.previousCompletedText, large.text);
  const resumedInputs: string[] = [];
  const result = await readWholeArticle({ body, model: "deepseek-flash", cache: saved,
    invoke: async call => { assert.ok(compact(call)); resumedInputs.push(input(call)); return "나머지 압축 사실"; } });
  assert.ok(result.completedAt); assert.match(result.text!, /FIRST_NARROW_SUCCESS/);
  assert.equal(result.previousCompletedText, undefined);
  assert.deepEqual([paidInputs[0], ...resumedInputs], splitWholeText(large.text!, 6000));
  assert.equal(resumedInputs[0], paidInputs[1]);
});

test("source diagnostics reconstruct missing parent checkpoints only from complete children", async () => {
  const body = "원".repeat(11999) + "🚀" + "끝".repeat(1000);
  const result = await readWholeArticle({ body, model: "deepseek-flash", packetBudget, invoke: async call => input(call) });
  const parts = splitWholeText(body), parentKey = hash(`0:0:${parts.length}:${parts[0]}`);
  const partial = structuredClone(result);
  delete partial.chunks[parentKey];
  assert.equal(readCachedSourceNotes(body, partial), result.text);
  let middle = Math.ceil(parts[0].length / 2);
  if (/[\uD800-\uDBFF]/.test(parts[0][middle - 1])) middle--;
  delete partial.chunks[hash(`recovery-v1:${parentKey}:0:${parts[0].slice(0, middle)}`)];
  assert.equal(readCachedSourceNotes(body, partial), null);
  assert.equal(readCachedSourceNotes(body + "changed", result), null);
});

test("invalid explicit packet budgets fail before invoking the provider", async () => {
  for (const budget of [{}, { maxBytes: 0 }, { maxChars: NaN }, { maxChars: 1.5 }] as ReadingPacketBudget[]) {
    await assert.rejects(readWholeArticle({ body: "source", model: "deepseek-flash", packetBudget: budget,
      invoke: async () => { throw Error("must not call"); } }), /Invalid reading packet budget/);
  }
});
