import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/mysql2";
import { failureGroupFromRow, failureUsageQueries, repeatedArticleFromRow, usageDateRange } from "../src/server/repo/llmUsage.js";

// Compile real MySQL queries without connecting to a database or calling an AI.
const store = drizzle.mock();
const now = new Date("2026-09-22T01:23:45Z");
const range = usageDateRange(now);

test("failure diagnosis aggregates only failed attempts in the same seven KST dates and separates provider/model/reason", () => {
  const { sql, params } = failureUsageQueries(store, range.since, range.until).failures.toSQL();
  assert.match(sql, /from `llm_usage` where/);
  assert.match(sql, /`llm_usage`\.`started_at` >= \?/);
  assert.match(sql, /`llm_usage`\.`started_at` <= \?/);
  assert.match(sql, /`llm_usage`\.`success` = \?/);
  assert.deepEqual(params, ["2026-09-15 15:00:00.000", "2026-09-22 01:23:45.000", false]);
  const group = sql.slice(sql.indexOf("group by"));
  for (const column of ["stage", "model", "endpoint_host", "thinking", "http_status", "finish_reason"]) {
    assert.ok(group.includes(`\`llm_usage\`.\`${column}\``), `must separate ${column}`);
  }
  assert.match(group, /DATE_FORMAT\(DATE_ADD\(`llm_usage`\.`started_at`, INTERVAL 9 HOUR\), '%Y-%m-%d'\)/);
  assert.match(sql, /COUNT\(`output_tokens`\)/, "known-output coverage is counted separately from failed attempts");
  assert.match(sql, /SUM\(`output_tokens`\)/, "failed/truncated calls retain their consumed output");
  for (const token of ["cache_hit_tokens", "cache_miss_tokens", "output_tokens"]) {
    assert.ok(sql.includes(`\`llm_usage\`.\`${token}\` IS NOT NULL`));
  }
  assert.match(sql, /CASE WHEN .* THEN `output_tokens` ELSE 0 END/);
  assert.doesNotMatch(sql, /\bjoin\b|`articles`|`body`|`title`|api_key|error_message/i);
});

test("repeat diagnosis requires an article and multiple failed attempts and applies SQL top20 order/limit", () => {
  const { sql, params } = failureUsageQueries(store, range.since, range.until).repeated.toSQL();
  assert.match(sql, /`llm_usage`\.`success` = \?/);
  assert.match(sql, /`llm_usage`\.`article_id` is not null/);
  assert.match(sql, /group by `llm_usage`\.`article_id`, `llm_usage`\.`stage`, `llm_usage`\.`http_status`, `llm_usage`\.`finish_reason`/);
  assert.match(sql, /having COUNT\(\*\) > 1/);
  assert.match(sql, /order by COUNT\(\*\) desc, MAX\(`llm_usage`\.`started_at`\) desc/);
  assert.match(sql, /limit \?$/);
  assert.deepEqual(params, ["2026-09-15 15:00:00.000", "2026-09-22 01:23:45.000", false, 20]);
  assert.match(sql, /DATE_FORMAT\(MAX\(`started_at`\), '%Y-%m-%dT%H:%i:%sZ'\)/);
  assert.doesNotMatch(sql, /`body`|`title`|\bjoin\b|api_key|error_message/i);
});

test("failure totals preserve null usage, distinguish zero, and expose pricing only for complete billing quantities", () => {
  const base = { day: "2026-09-22", stage: "whole_reading" as const, model: "deepseek-flash", endpointHost: "api.deepseek.com",
    thinking: "disabled" as const, httpStatus: 200, finishReason: "length", requests: "4", outputKnown: "3", outputTokens: "9600",
    pricedRequests: "2", pricedHit: "128", pricedMiss: "2500", pricedOutput: "6400" };
  const failed = failureGroupFromRow(base);
  assert.equal(failed.requests, 4);
  assert.equal(failed.outputKnown, 3);
  assert.equal(failed.outputTokens, 9600, "include received usage even when cache usage is missing");
  assert.deepEqual(failed.costBasis, { requests: 2, cacheHitTokens: 128, cacheMissTokens: 2500, outputTokens: 6400 });
  assert.equal(failed.finishReason, "length");
  const unknown = failureGroupFromRow({ ...base, httpStatus: 402, finishReason: null, outputKnown: "0", outputTokens: null,
    pricedRequests: "0", pricedHit: "0", pricedMiss: "0", pricedOutput: "0" });
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.outputKnown, 0);
  assert.equal(unknown.costBasis.requests, 0);
  const zero = failureGroupFromRow({ ...base, outputTokens: "0", outputKnown: "4", pricedOutput: "0" });
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.outputKnown, 4);
});

test("repeated article entries contain only the aggregate identity, count and UTC last failure timestamp", () => {
  const repeated = repeatedArticleFromRow({ articleId: "52", stage: "whole_reading", httpStatus: 200,
    finishReason: "length", failures: "7", lastAt: "2026-09-22T01:23:45Z" });
  assert.deepEqual(repeated, { articleId: 52, stage: "whole_reading", httpStatus: 200,
    finishReason: "length", failures: 7, lastAt: "2026-09-22T01:23:45Z" });
  assert.equal(new Date(repeated.lastAt).toISOString(), "2026-09-22T01:23:45.000Z");
});
