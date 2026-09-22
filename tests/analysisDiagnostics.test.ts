import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/mysql2";
import { readingDiagnostics } from "../src/shared/analysisDiagnostics.js";
import type { ReadingCache } from "../src/shared/articleContent.js";
import { articleDiagnosticQueries, articleDiagnosticsFromRows } from "../src/server/repo/analysisDiagnostics.js";
import { settingsRouter } from "../src/server/trpc/routers/settings.js";
import { readWholeArticle } from "../src/server/analysis/fullReading.js";

const store = drizzle.mock();

test("diagnosis reads only one nondeleted article and the latest 30 attempts for that same ID", () => {
  const queries = articleDiagnosticQueries(store, 83479);
  const article = queries.article.toSQL();
  assert.match(article.sql, /`articles`\.`id` = \? and `articles`\.`deleted_at` is null/);
  assert.deepEqual(article.params, [83479, 1]);
  assert.match(article.sql, /left join `analyses`/);
  assert.doesNotMatch(article.sql, /`config`|`session|api_key|insert |update |delete /i);
  const usage = queries.attempts.toSQL();
  assert.match(usage.sql, /from `llm_usage` where `llm_usage`\.`article_id` = \?/);
  assert.match(usage.sql, /order by `llm_usage`\.`started_at` desc, `llm_usage`\.`id` desc limit \?/);
  assert.deepEqual(usage.params, [83479, 30]);
  assert.doesNotMatch(usage.sql, /`request_id`|`run_id`|`body`|prompt|error_message|api_key|insert |update |delete /i);
});

test("cache diagnosis preserves counts and selects bounded deterministic first/middle/last successful samples", () => {
  const long = "가".repeat(2999) + "🚀" + "나".repeat(5000);
  const cache: ReadingCache = { version: 1, key: "private-cache-key", chunks: { e: "끝", b: "두 번째", a: long, d: "네 번째", c: "중간", empty: " " },
    inputChars: 120000, chunkCount: 10,
    recovery: { version: 1, policy: 2, inputCharLimit: 3000, splits: { first: true, other: true }, proactiveSplits: { first: true }, calls: 4,
      held: { reason: "output_limit", at: "2026-09-22T04:29:00.000Z" } } };
  const snapshot = structuredClone(cache);
  const view = readingDiagnostics(cache)!;
  assert.equal(view.savedChunkCount, 5);
  assert.equal(view.savedChunkChars, long.length + 4 + 4 + 2 + 1);
  assert.deepEqual(view.samples.map(sample => sample.ordinal), [1, 3, 5]);
  assert.equal(view.samples[0].text.length, 2999, "preview must not cut a surrogate pair");
  assert.equal(view.samples[0].truncated, true);
  assert.equal(view.samples[0].chars, long.length);
  assert.deepEqual(view.samples.slice(1).map(sample => sample.text), ["중간", "끝"]);
  assert.equal(view.recovery?.splitCount, 2); assert.equal(view.recovery?.proactiveSplitCount, 1);
  assert.equal(view.recovery?.calls, 4); assert.equal(view.recovery?.held?.reason, "output_limit");
  assert.equal(view.recovery?.inputCharLimit, 3000);
  assert.doesNotMatch(JSON.stringify(view), /private-cache-key|"splits"|"chunks"/);
  assert.deepEqual(cache, snapshot, "inspection must not reset a hold, counter or cache");
});

test("missing, empty, legacy and completed caches stay distinct without duplicate samples", () => {
  assert.equal(readingDiagnostics(null), null);
  const cache: ReadingCache = { version: 1, key: "key", chunks: {}, inputChars: 13000, chunkCount: 2 };
  assert.deepEqual(readingDiagnostics(cache)?.samples, []);
  assert.equal(readingDiagnostics(cache)?.recovery, null);
  const complete = readingDiagnostics({ ...cache, chunks: { only: "요약" }, completedAt: "2026-09-22T00:00:00Z", text: "결과" })!;
  assert.equal(complete.samples.length, 1); assert.equal(complete.completedAt, "2026-09-22T00:00:00Z");
  const two = readingDiagnostics({ ...cache, chunks: { a: "1", b: "2" } })!;
  assert.equal(two.samples.length, 2);
});

test("article DTO retains the complete body but only source length and safe projected usage fields", () => {
  const body = "원문 시작\n" + "자료 🚀".repeat(9000) + "\n끝의 별도 결론";
  const row = { id: 83479, title: "제목", url: "https://example.test/article", provider: "telegram" as const,
    body, sourceBody: "SOURCE_TEXT_ONLY_LENGTH", contentMeta: { version: 1 as const, status: "partial" as const, method: "post" as const,
      checkedAt: "2026-09-22T00:00:00Z", links: [{ url: "x", status: "extracted" as const }, { url: "y", status: "unavailable" as const }] },
    readingCache: null, analysisId: null, analyzedAt: null, apiKey: "PRIVATE_KEY", prompt: "PRIVATE_PROMPT" };
  const attempt = { startedAt: new Date("2026-09-22T04:29:00Z"), stage: "whole_reading" as const, model: "deepseek-flash", thinking: "disabled" as const,
    success: false, durationMs: 90_000, httpStatus: 200, finishReason: "length", errorCategory: null, errorParam: null,
    inputTokens: null, outputTokens: 3200, errorMessage: "PRIVATE_PROVIDER_MESSAGE", requestId: "PRIVATE_REQUEST_ID" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("diagnostics must never make an external request"); };
  try {
    const view = articleDiagnosticsFromRows(row, Array.from({ length: 40 }, () => attempt));
    assert.equal(view.body, body); assert.equal(view.bodyChars, body.length);
    assert.equal(view.sourceBodyChars, row.sourceBody.length);
    assert.equal(view.content.extractedLinks, 1); assert.equal(view.content.unavailableLinks, 1);
    assert.deepEqual(view.analysis, { completed: false, analyzedAt: null });
    assert.equal(view.sourceReading, null);
    assert.equal(view.attempts.length, 30); assert.equal(view.attempts[0].outputTokens, 3200);
    assert.equal(view.attempts[0].inputTokens, null); assert.equal(view.attempts[0].startedAt, "2026-09-22T04:29:00.000Z");
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|SOURCE_TEXT_ONLY_LENGTH|errorMessage|requestId/);
    assert.deepEqual(articleDiagnosticsFromRows({ ...row, body: null, sourceBody: null, analysisId: 10, analyzedAt: attempt.startedAt }, []).analysis,
      { completed: true, analyzedAt: "2026-09-22T04:29:00.000Z" });
  } finally { globalThis.fetch = originalFetch; }
});

test("diagnostic query rejects missing, bulk and invalid IDs before touching storage", async () => {
  const caller = settingsRouter.createCaller({});
  for (const input of [{}, { articleId: 0 }, { articleId: -1 }, { articleId: 1.1 }, { articleId: "83479" },
    { articleId: Number.MAX_SAFE_INTEGER + 1 }, { articleId: 83479, articleIds: [83479, 83480] }]) {
    await assert.rejects(caller.getArticleAnalysisDiagnostics(input as { articleId: number }), { code: "BAD_REQUEST" });
  }
});

test("source reading diagnosis counts only all original segments, not arbitrary parent or reduction cache totals", async () => {
  const body = "원".repeat(13000);
  const cache = await readWholeArticle({ body, model: "deepseek-flash", invoke: async () => "원문의 핵심 사실" });
  cache.chunks["unrelated-cached-reduction"] = "중복하면 안 되는 이전 압축".repeat(500);
  const row = { id: 83479, title: null, url: null, provider: null, body, sourceBody: null,
    contentMeta: null, readingCache: cache, analysisId: null, analyzedAt: null };
  const view = articleDiagnosticsFromRows(row, []);
  assert.equal(view.sourceReading?.completed, true);
  assert.equal(view.sourceReading?.chars, cache.text!.length);
  assert.equal(view.sourceReading?.bytes, Buffer.byteLength(cache.text!, "utf8"));
  assert.ok(view.reading!.savedChunkChars > view.sourceReading!.chars!);
  const incomplete = articleDiagnosticsFromRows({ ...row, readingCache: { ...cache, chunks: {} } }, []);
  assert.deepEqual(incomplete.sourceReading, { completed: false, chars: null, bytes: null });
});
