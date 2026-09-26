import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { analysisConfigFingerprint, articleContentFingerprint, analysisFailureReason, filterTokenLimit, correctedFilterTokenLimit, globalPauseMinutes, nextAnalysisRetry } from "../src/server/analysis/retryPolicy.js";
import { analysisRetryEligible, articleContentFingerprintSql, matchingAnalysisRetry } from "../src/server/repo/analysisRetry.js";
import { filterRelevant } from "../src/server/analysis/analyze.js";
import { isLlmOutputLimitError, WholeReadingHeldError } from "../src/server/analysis/llmErrors.js";
import { withLlmUsageSink } from "../src/server/analysis/usageObservation.js";
import type { AnalysisConfig, Article } from "../src/server/db/schema.js";

const envKeys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY", "FILTER_MAX_TOKENS"] as const;
const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } });
const cfg: AnalysisConfig = { instructions: "모든 근거를 검토한다", filterModel: "deepseek-flash", summaryInstructions: "핵심과 반론을 요약한다" };
const article = { id: 123, title: "실적 발표", url: null, body: "매출은 100이고 이익은 10이다. 반론도 확인한다.", sourceBody: "원문", contentMeta: null } as Article;
const ok = JSON.stringify({ relevant: true, important: true, summary: "한국어로 모든 핵심과 반론을 요약했습니다." });
function response(content: string, finish_reason: string) { return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 1400 } })); }
function provider() { process.env.LLM_BASE_URL = "https://api.deepseek.com"; process.env.LLM_API_KEY = "synthetic-test"; process.env.FILTER_MAX_TOKENS = "1400"; delete process.env.LLM_EXTRA_BODY; }

test("transient retries back off and hold on third failure; deterministic failures hold immediately", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  const first = nextAnalysisRetry(0, "transient", now), second = nextAnalysisRetry(1, "transient", now), third = nextAnalysisRetry(2, "transient", now);
  assert.equal(first.nextRetryAt?.getTime(), now.getTime() + 30 * 60_000);
  assert.equal(second.nextRetryAt?.getTime(), now.getTime() + 2 * 3600_000);
  assert.equal(third.held, true); assert.equal(third.nextRetryAt, null);
  for (const reason of ["output_limit", "reading_held", "request_rejected"] as const) assert.equal(nextAnalysisRetry(0, reason, now).held, true);
  assert.equal(analysisFailureReason(new WholeReadingHeldError()), "reading_held");
  assert.equal(analysisFailureReason(new Error("LLM API 400: provider request failed")), "request_rejected");
  assert.equal(globalPauseMinutes(analysisFailureReason(new Error("LLM API 402: provider request failed"))), 60);
  for (const status of [401, 403]) assert.equal(globalPauseMinutes(analysisFailureReason(new Error(`LLM API ${status}: provider request failed`))), 60);
  assert.equal(globalPauseMinutes(analysisFailureReason(new Error("LLM API 429: provider request failed"))), 30);
});

test("retry signatures change for actual content and effective settings but not reading checkpoints", () => {
  const content = articleContentFingerprint(article), config = analysisConfigFingerprint(cfg, true);
  assert.notEqual(articleContentFingerprint({ ...article, body: `${article.body} 새로운 사실` }), content);
  assert.equal(articleContentFingerprint({ ...article, readingCache: { completedAt: "later" } } as Article), content);
  assert.notEqual(analysisConfigFingerprint({ ...cfg, filterThinking: "enabled" }, true), config);
  assert.notEqual(analysisConfigFingerprint({ ...cfg, summaryInstructions: "수정한 지침" }, true), config);
  process.env.FILTER_MAX_TOKENS = "3000";
  assert.notEqual(analysisConfigFingerprint(cfg, true), config);
  const dialect = new MySqlDialect();
  assert.match(dialect.sqlToQuery(articleContentFingerprintSql()).sql, /OCTET_LENGTH/);
  assert.match(dialect.sqlToQuery(matchingAnalysisRetry(config)!).sql, /`config_key` = \?.*`content_key` = SHA2/);
  assert.match(dialect.sqlToQuery(analysisRetryEligible()!).sql, /`article_id` is null.*`held` = \?.*`next_retry_at` <= \?/);
});

test("filter retries a length response once with preserved instructions, bounded larger budget and complete JSON", async () => {
  provider();
  const requests: { max_tokens: number; messages: { content: string }[]; thinking: { type: string } }[] = [];
  let marked = 0;
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return requests.length === 1 ? response('{"relevant":true', "length") : response(ok, "stop"); };
  const result = await withLlmUsageSink(() => {}, () => filterRelevant(article, cfg, "", [], { corrected: false, onCorrection: async () => { marked++; } }));
  assert.equal(result.relevant, true); assert.equal(marked, 1);
  assert.deepEqual(requests.map(request => request.max_tokens), [1400, 2800]);
  assert.ok(requests[1].messages[0].content.startsWith(requests[0].messages[0].content));
  assert.deepEqual(requests.map(request => request.thinking.type), ["disabled", "disabled"]);
  assert.equal(correctedFilterTokenLimit(5000), 6000);
});

test("full-body filter starts with room for complete JSON while preserving user settings and explicit limits", async () => {
  provider(); delete process.env.FILTER_MAX_TOKENS;
  assert.equal(filterTokenLimit(false), 1600);
  assert.equal(filterTokenLimit(true), 2800);
  const requests: any[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return response(ok, "stop"); };
  await withLlmUsageSink(() => {}, () => filterRelevant(article, { ...cfg, relevanceCriteria: "전부" }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 1600);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.ok(requests[0].messages[0].content.includes(cfg.summaryInstructions));
  assert.match(requests[0].messages[0].content, /관련성 판단 기준\]\n전부/);
  assert.ok(requests[0].messages[1].content.includes(article.body));
  process.env.FILTER_MAX_TOKENS = "4200";
  assert.equal(filterTokenLimit(false), 4200);
});

test("corrected filter strategy survives a later transient failure and does not repeat the old request", async () => {
  provider(); let corrected = false; const budgets: number[] = [];
  globalThis.fetch = async (_url, init) => { budgets.push(JSON.parse(String(init?.body)).max_tokens); if (budgets.length === 1) return response("partial", "length"); throw Error("network interrupted"); };
  await withLlmUsageSink(() => {}, async () => {
    await assert.rejects(filterRelevant(article, cfg, "", [], { corrected, onCorrection: async () => { corrected = true; } }), /network interrupted/);
    assert.equal(corrected, true);
    globalThis.fetch = async (_url, init) => { budgets.push(JSON.parse(String(init?.body)).max_tokens); return response(ok, "stop"); };
    await filterRelevant(article, cfg, "", [], { corrected, onCorrection: async () => { assert.fail("already corrected"); } });
  });
  assert.deepEqual(budgets, [1400, 2800, 2800]);
});

test("two length responses remain a failure and HTTP400 is not retried inline", async () => {
  provider(); let calls = 0;
  await withLlmUsageSink(() => {}, async () => {
    globalThis.fetch = async () => { calls++; return response("partial", "length"); };
    await assert.rejects(filterRelevant(article, cfg), isLlmOutputLimitError);
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("rejected", { status: 400 }); };
    await assert.rejects(filterRelevant(article, cfg), /LLM API 400/);
    assert.equal(calls, 1);
  });
});
