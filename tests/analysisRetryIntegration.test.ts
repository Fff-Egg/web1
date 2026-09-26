import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import type { Article } from "../src/server/db/schema.js";

const keys = ["DATABASE_URL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY", "ANALYZE_BATCH", "ANALYZE_CONCURRENCY"] as const;
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = "mysql://synthetic:synthetic@127.0.0.1:1/test";
process.env.LLM_BASE_URL = "https://api.deepseek.com";
process.env.LLM_API_KEY = "synthetic-only";
process.env.ANALYZE_BATCH = "2"; process.env.ANALYZE_CONCURRENCY = "1"; delete process.env.LLM_EXTRA_BODY;
const { db, pool } = await import("../src/server/db/client.js");
const schema = await import("../src/server/db/schema.js");
const { runAnalysis, runArticleAnalysis } = await import("../src/server/analysis/analyze.js");
const { settingsRouter } = await import("../src/server/trpc/routers/settings.js");
const { articleContentFingerprint, analysisConfigFingerprint } = await import("../src/server/analysis/retryPolicy.js");
const { resetAnalysisRetry, reserveAnalysisAttempt, markAnalysisFilterCorrection } = await import("../src/server/repo/analysisRetry.js");
const { withLlmUsageSink } = await import("../src/server/analysis/usageObservation.js");
const original = { select: db.select, insert: db.insert, update: db.update, delete: db.delete, fetch: globalThis.fetch };
afterEach(() => { Object.assign(db, { select: original.select, insert: original.insert, update: original.update, delete: original.delete }); globalThis.fetch = original.fetch; });
after(async () => { await pool?.end(); for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } });

function fixture() {
  const articles = new Map<number, Article>();
  const retries = new Map<number, typeof schema.analysisRetries.$inferSelect>();
  const settings = new Map<string, unknown>([["analysis", { instructions: "실적과 근거를 요약한다", filterModel: "deepseek-flash" }]]);
  const analyses = new Set<number>();
  const calls: number[] = [];
  let httpStatus = 400;
  const dialect = new MySqlDialect();
  const query = (where?: SQL) => where ? dialect.sqlToQuery(where) : { sql: "", params: [] };
  const pending = () => [...articles.values()].filter(article => !article.deletedAt && !analyses.has(article.id));
  const add = (id: number, bad = true) => articles.set(id, { id, sourceId: 1, externalId: String(id), title: `article ${id}`, url: null,
    body: `${bad ? "BAD " : "GOOD "}매출이 100억원으로 증가했고 수익성 개선 근거도 제시했다. 투자에 영향을 주는 이익과 반론을 함께 확인한다.`,
    sourceBody: null, author: null, publishedAt: null, fetchedAt: new Date(), contentMeta: { version: 1, status: "post", method: "post", checkedAt: "2026-09-22T00:00:00Z", links: [] }, readingCache: null, deletedAt: null });
  db.select = ((shape?: Record<string, unknown>) => {
    let table: unknown; let where: SQL | undefined; let join: SQL | undefined; let limit = Infinity;
    const rows = () => {
      const q = query(where);
      if (table === schema.settings) { const key = String(q.params[0]); return settings.has(key) ? [{ key, value: structuredClone(settings.get(key)) }] : []; }
      if (table === schema.analysisRetries) {
        const value = retries.get(Number(q.params[0]));
        return value && value.configKey === q.params[1] && value.contentKey === q.params[2] ? [structuredClone(value)] : [];
      }
      if (table !== schema.articles) return [];
      if (shape && "retry" in shape) {
        assert.match(q.sql, /`analysis_retries`\.`held` = \?/);
        const configKey = query(join).params.find(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
        const selectedId = /`articles`\.`id` = \?/.exec(q.sql);
        const articleId = selectedId ? q.params[(q.sql.slice(0, selectedId.index).match(/\?/g) ?? []).length] : undefined;
        return pending().filter(article => articleId === undefined || article.id === articleId).sort((a, b) => b.id - a.id).map(article => {
          const stored = retries.get(article.id);
          const retry = stored && stored.configKey === configKey && stored.contentKey === articleContentFingerprint(article) ? stored : null;
          return { article: structuredClone(article), retry: retry ? structuredClone(retry) : null };
        }).filter(({ retry }) => !retry || !retry.held && (!retry.nextRetryAt || retry.nextRetryAt.getTime() <= Date.now())).slice(0, limit);
      }
      if (shape && "id" in shape && q.sql.includes("analysis_retries")) {
        const id = q.params.find(value => typeof value === "number");
        return pending().filter(article => (id === undefined || article.id === id) && (retries.has(article.id) || article.readingCache?.recovery?.held)).map(article => ({ id: article.id }));
      }
      if (shape && "id" in shape && q.sql.includes("NOT IN")) {
        return pending().filter(article => article.id === q.params[0]).slice(0, limit).map(article => ({ id: article.id }));
      }
      const article = articles.get(Number(q.params[0]));
      if (!article || q.sql.includes("deleted_at` is null") && article.deletedAt) return [];
      return shape && "article" in shape ? [{ article: structuredClone(article), source: { id: 1, provider: "telegram", config: null } }] : [structuredClone(article)];
    };
    const builder = {
      from: (value: unknown) => { table = value; return builder; },
      leftJoin: (_table: unknown, on: SQL) => { join = on; return builder; },
      innerJoin: (_table: unknown, on: SQL) => { join = on; return builder; },
      where: (value: SQL) => { where = value; return builder; },
      orderBy: () => builder,
      limit: async (value: number) => { limit = value; return rows(); },
      then: (resolve: (value: unknown) => void) => resolve(rows()),
    };
    return builder;
  }) as unknown as typeof db.select;
  db.insert = ((table: unknown) => ({ values: (value: Record<string, unknown>) => {
    const save = () => {
      if (table === schema.analysisRetries) retries.set(Number(value.articleId), structuredClone(value) as typeof schema.analysisRetries.$inferSelect);
      if (table === schema.analyses) analyses.add(Number(value.articleId));
      if (table === schema.settings) settings.set(String(value.key), structuredClone(value.value));
      return [{ affectedRows: 1 }];
    };
    return { onDuplicateKeyUpdate: async () => save(), then: (resolve: (value: unknown) => void) => resolve(save()) };
  } })) as unknown as typeof db.insert;
  db.update = ((_table: unknown) => ({ set: (patch: Partial<Article>) => ({ where: async (where: SQL) => {
    const article = articles.get(Number(query(where).params[0]));
    if (!article) return [{ affectedRows: 0 }];
    Object.assign(article, structuredClone(patch)); return [{ affectedRows: 1 }];
  } }) })) as unknown as typeof db.update;
  db.delete = ((table: unknown) => ({ where: async (where: SQL) => {
    const value = query(where).params[0];
    if (table === schema.analysisRetries) retries.delete(Number(value));
    if (table === schema.settings) settings.delete(String(value));
    return [{ affectedRows: 1 }];
  } })) as unknown as typeof db.delete;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content as string;
    calls.push(Number(/제목: article (\d+)/.exec(prompt)?.[1]));
    return prompt.includes("BAD") ? new Response("synthetic provider rejection", { status: httpStatus }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ relevant: true, important: true, summary: "실적과 근거를 한국어로 요약했다." }) }, finish_reason: "stop" }] }));
  };
  return { add, articles, retries, settings, analyses, calls, set httpStatus(status: number) { httpStatus = status; } };
}

test("held articles survive later polls while new/older eligible articles fill the batch", async () => {
  const state = fixture(); state.add(3); state.add(2); state.add(1, false);
  await withLlmUsageSink(() => {}, async () => {
    assert.equal((await runAnalysis()).errors, 2);
    assert.deepEqual(state.calls, [3, 2]);
    assert.equal(state.retries.get(3)?.held, true); assert.equal(state.retries.get(2)?.held, true);
    state.add(4, false);
    assert.equal((await runAnalysis()).analyzed, 2);
    assert.deepEqual(state.calls, [3, 2, 4, 1]);
    await runAnalysis(); assert.equal(state.calls.length, 4);
    assert.equal(state.articles.size, 4, "failure never deletes an article");
    state.settings.set("analysis", { instructions: "변경된 분석 지침", filterModel: "deepseek-flash" });
    assert.equal((await runAnalysis()).errors, 2);
    assert.deepEqual(state.calls.slice(-2), [3, 2], "settings change releases matching-input holds");
  });
});

test("402 stops the batch, durable global cooldown blocks next poll, explicit reset schedules later retry", async () => {
  const state = fixture(); state.httpStatus = 402; state.add(3); state.add(2);
  await withLlmUsageSink(() => {}, async () => {
    assert.equal((await runAnalysis()).errors, 1);
    assert.deepEqual(state.calls, [3]);
    assert.ok(state.settings.has("analysisRetryPause"));
    await runAnalysis(); assert.deepEqual(state.calls, [3]);
    const reset = await resetAnalysisRetry();
    assert.equal(reset.reset, 1); assert.equal(state.settings.has("analysisRetryPause"), false);
    assert.deepEqual(state.calls, [3], "reset does not invoke any model");
    state.articles.get(3)!.body = "GOOD 매출이 100억원으로 증가했고 이익 전망이 개선되어 투자에 중요한 변화를 확인했다.";
    state.articles.get(2)!.body = "GOOD 매출이 200억원으로 증가했고 이익 전망이 개선되어 투자에 중요한 변화를 확인했다.";
    assert.equal((await runAnalysis()).analyzed, 2);
    assert.deepEqual(state.calls, [3, 3, 2]);
  });
});

test("interrupted paid attempts leave durable reservations and the third reservation holds until reset", async () => {
  const state = fixture(); state.add(1);
  const article = state.articles.get(1)!;
  const configKey = analysisConfigFingerprint({ instructions: "실적과 근거를 요약한다", filterModel: "deepseek-flash" }, false);
  const first = await reserveAnalysisAttempt(article, configKey);
  assert.equal(first.attempts, 1);
  await markAnalysisFilterCorrection(article, configKey);
  assert.equal(state.retries.get(1)?.attempts, 1);
  assert.equal(state.retries.get(1)?.filterCorrected, true);
  assert.ok(state.retries.get(1)?.nextRetryAt, "correction must not erase the crash-recovery lease");
  // Reconstruct each subsequent reservation from persisted rows without calling
  // recordAnalysisFailure: this is the process-killed-during-provider-call case.
  assert.equal((await reserveAnalysisAttempt(article, configKey)).attempts, 2);
  assert.equal((await reserveAnalysisAttempt(article, configKey)).attempts, 3);
  assert.equal(state.retries.get(1)?.held, true);
  await assert.rejects(reserveAnalysisAttempt(article, configKey), /횟수를 소진/);
  assert.equal((await resetAnalysisRetry(1)).reset, 1);
  assert.equal((await reserveAnalysisAttempt(article, configKey)).attempts, 1);
  assert.equal(state.calls.length, 0);
});

test("manual retry runs only the selected pending article and leaves other holds untouched", async () => {
  const state = fixture(); state.add(1); state.add(2); state.add(3, false);
  const configKey = analysisConfigFingerprint({ instructions: "실적과 근거를 요약한다", filterModel: "deepseek-flash" }, false);
  for (const id of [1, 2]) {
    for (let attempt = 0; attempt < 3; attempt++) await reserveAnalysisAttempt(state.articles.get(id)!, configKey);
  }
  state.settings.set("analysisRetryPause", { reason: "balance", until: new Date(Date.now() + 3600_000).toISOString() });
  const other = structuredClone(state.retries.get(2));
  const result = await withLlmUsageSink(() => {}, () => settingsRouter.createCaller({}).runArticleAnalysis({ articleId: 1 }));
  assert.deepEqual(result, { analyzed: 0, relevant: 0, errors: 1, busy: false });
  assert.deepEqual(state.calls, [1], "ID selection happens before the batch limit; no other article is called");
  assert.deepEqual(state.retries.get(2), other);
  assert.equal(state.analyses.has(3), false);
  assert.equal(state.retries.get(1)?.attempts, 1, "only selected article received an explicit reset");
  assert.equal(state.settings.has("analysisRetryPause"), true, "selected retry preserves the global provider cooldown");
  await withLlmUsageSink(() => {}, () => runAnalysis());
  assert.deepEqual(state.calls, [1], "subsequent scheduled work remains paused");
});

test("single-article route rejects missing, invalid and bulk IDs before any retry reset or API call", async () => {
  const state = fixture(); state.add(1, false);
  const pause = { reason: "balance", until: new Date(Date.now() + 3600_000).toISOString() };
  state.settings.set("analysisRetryPause", pause);
  const caller = settingsRouter.createCaller({});
  for (const invalid of [{}, { articleId: 0 }, { articleId: -1 }, { articleId: 1.5 }, { articleId: "1" }, { articleId: Number.MAX_SAFE_INTEGER + 1 }, { articleId: 1, articleIds: [1, 2] }]) {
    await assert.rejects(caller.runArticleAnalysis(invalid as { articleId: number }), { code: "BAD_REQUEST" });
  }
  assert.deepEqual(state.calls, []);
  assert.equal(state.retries.size, 0);
  assert.deepEqual(state.settings.get("analysisRetryPause"), pause);
});

test("manual retry of completed/deleted/missing articles is empty and leaves provider cooldown unchanged", async () => {
  const state = fixture(); state.add(1, false); state.add(2, false); state.add(3, false);
  state.analyses.add(1);
  state.articles.get(2)!.deletedAt = new Date();
  const pause = { reason: "balance", until: new Date(Date.now() + 3600_000).toISOString() };
  state.settings.set("analysisRetryPause", pause);
  await withLlmUsageSink(() => {}, async () => {
    for (const id of [1, 2, 999]) assert.deepEqual(await runArticleAnalysis(id), { analyzed: 0, relevant: 0, errors: 0, busy: false });
  });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.settings.get("analysisRetryPause"), pause);
});

test("concurrent manual retry clicks return busy without resetting or multiplying paid work", async () => {
  const state = fixture(); state.add(1, false); state.add(2, false);
  const provider = globalThis.fetch;
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => { started(); await wait; return provider(url, init); };
  await withLlmUsageSink(() => {}, async () => {
    const first = runArticleAnalysis(1);
    assert.deepEqual(await runArticleAnalysis(1), { analyzed: 0, relevant: 0, errors: 0, busy: true }, "guard is acquired before preflight and reset");
    await began;
    try {
      assert.deepEqual(await runArticleAnalysis(1), { analyzed: 0, relevant: 0, errors: 0, busy: true });
      assert.deepEqual(await runArticleAnalysis(2), { analyzed: 0, relevant: 0, errors: 0, busy: true });
      assert.equal(state.retries.get(1)?.attempts, 1);
      assert.equal(state.retries.has(2), false);
    } finally { release(); }
    assert.deepEqual(await first, { analyzed: 1, relevant: 1, errors: 0, busy: false });
  });
  assert.deepEqual(state.calls, [1]);
  assert.equal(state.analyses.has(2), false);
});

test("an active scheduled batch makes selected manual retry busy before it clears cooldown or reservations", async () => {
  const state = fixture(); state.add(1, false);
  const provider = globalThis.fetch;
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => { started(); await wait; return provider(url, init); };
  await withLlmUsageSink(() => {}, async () => {
    const scheduled = runAnalysis();
    await began;
    try {
      const reservation = structuredClone(state.retries.get(1));
      assert.deepEqual(await runArticleAnalysis(1), { analyzed: 0, relevant: 0, errors: 0, busy: true });
      assert.deepEqual(state.retries.get(1), reservation);
    } finally { release(); }
    assert.equal((await scheduled).analyzed, 1);
  });
  assert.deepEqual(state.calls, [1]);
});
