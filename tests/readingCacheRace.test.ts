import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { articles, type Article, type AnalysisConfig, type Source } from "../src/server/db/schema.js";

// Use the real repository/collector/reader with an in-memory Drizzle boundary.
// Neither the placeholder MySQL connection nor a paid model is contacted.
const envKeys = ["DATABASE_URL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = "mysql://test:test@127.0.0.1:1/test";
process.env.LLM_BASE_URL = "https://example.invalid/v1";
process.env.LLM_API_KEY = "synthetic-only";
delete process.env.LLM_EXTRA_BODY;
const { db, pool } = await import("../src/server/db/client.js");
const { collectSource } = await import("../src/server/workers/collect.js");
const { getAdapter } = await import("../src/server/adapters/registry.js");
const { prepareStoredArticle } = await import("../src/server/repo/articleContent.js");
const adapter = getAdapter("telegram")!;
const originals = { select: db.select, insert: db.insert, update: db.update, fetch: globalThis.fetch, adapterFetch: adapter.fetch };
afterEach(() => { db.select = originals.select; db.insert = originals.insert; db.update = originals.update; adapter.fetch = originals.adapterFetch; globalThis.fetch = originals.fetch; });
after(async () => { await pool?.end(); for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } });

const source = { id: 991, provider: "telegram", identifier: "fixture", config: null } as Source;
const body = "처음부터 끝까지 읽는 원문과 근거입니다. ".repeat(700);
const cfg: AnalysisConfig = { instructions: "test", filterModel: "test-model" };
const dialect = new MySqlDialect();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let article: Article | null = null;
  let calls = 0;
  let beforeWrite: ((patch: Partial<Article>) => Promise<void>) | undefined;
  let beforeSelect: ((joined: boolean) => Promise<void>) | undefined;
  let invoke: (() => Promise<string>) | undefined;
  const patches: Partial<Article>[] = [];
  const fieldMap: Record<string, keyof Article> = { id: "id", source_id: "sourceId", external_id: "externalId", deleted_at: "deletedAt", body: "body", source_body: "sourceBody", content_meta: "contentMeta" };
  const matches = (where: SQL) => {
    if (!article) return false;
    const query = dialect.sqlToQuery(where);
    for (const match of query.sql.matchAll(/(?:BINARY )?`articles`\.`(\w+)`\s*=\s*(?:BINARY )?\?/g)) {
      const index = (query.sql.slice(0, match.index).match(/\?/g) ?? []).length;
      if (match[1] === "body" || match[1] === "source_body") assert.match(match[0], /^BINARY .* = BINARY \?$/, "snapshot comparisons must not use case/accent-insensitive MySQL collation");
      if (article[fieldMap[match[1]]] !== query.params[index]) return false;
    }
    for (const match of query.sql.matchAll(/`articles`\.`(\w+)`\s+is null/g)) {
      if (article[fieldMap[match[1]]] !== null) return false;
    }
    const checked = /JSON_UNQUOTE\(JSON_EXTRACT\(`articles`\.`content_meta`, '\$\.checkedAt'\)\) = \?/.exec(query.sql);
    if (checked) {
      const index = (query.sql.slice(0, checked.index).match(/\?/g) ?? []).length;
      if (article.contentMeta?.checkedAt !== query.params[index]) return false;
    }
    return true;
  };
  db.select = ((shape?: Record<string, unknown>) => {
    let joined = false;
    const builder = {
      from: () => builder,
      innerJoin: () => { joined = true; return builder; },
      where: (where: SQL) => ({ limit: async () => {
        await beforeSelect?.(joined);
        if (!matches(where)) return [];
        return joined ? [{ article: structuredClone(article), source }] : [Object.fromEntries(Object.keys(shape ?? {}).map(key => [key, article![key as keyof Article]]))];
      } }),
    };
    return builder;
  }) as unknown as typeof db.select;
  db.insert = ((table: unknown) => ({ values: (value: Partial<Article>) => ({ onDuplicateKeyUpdate: async () => {
    if (table !== articles) return [{ affectedRows: 1 }]; // Usage ledger is independent of article content.
    article = { id: 1, readingCache: null, deletedAt: null, url: null, title: null, author: null, publishedAt: null, fetchedAt: new Date(), ...value } as Article;
    return [{ affectedRows: 1, insertId: 1 }];
  } }) })) as unknown as typeof db.insert;
  db.update = (() => ({ set: (patch: Partial<Article>) => ({ where: async (where: SQL) => {
    await beforeWrite?.(patch);
    if (!matches(where)) return [{ affectedRows: 0 }];
    patches.push(structuredClone(patch));
    article = { ...article!, ...structuredClone(patch) };
    return [{ affectedRows: 1 }];
  } }) })) as unknown as typeof db.update;
  adapter.fetch = async () => [{ externalId: "race", body }];
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://example.invalid/v1/chat/completions");
    calls++;
    const content = invoke ? await invoke() : "원문의 수치와 근거를 모두 읽은 구간 요약";
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  };
  return {
    get article() { return article!; }, get calls() { return calls; }, patches,
    set beforeWrite(value: typeof beforeWrite) { beforeWrite = value; },
    set beforeSelect(value: typeof beforeSelect) { beforeSelect = value; },
    set invoke(value: typeof invoke) { invoke = value; },
  };
}

test("collection finishing after analysis preserves its completed reading without extra calls", async () => {
  const state = fixture();
  const entered = deferred(); const release = deferred();
  state.beforeSelect = async joined => {
    if (!joined && state.article) { state.beforeSelect = undefined; entered.resolve(); await release.promise; }
  };
  const collection = collectSource(source);
  await entered.promise;
  await prepareStoredArticle(1, cfg);
  const cache = structuredClone(state.article.readingCache);
  const calls = state.calls;
  assert.equal(calls, 2); assert.ok(cache?.completedAt);
  release.resolve(); await collection;
  assert.deepEqual(state.article.readingCache, cache);
  await prepareStoredArticle(1, cfg);
  assert.equal(state.calls, calls);
  assert.equal(state.patches.filter(patch => "body" in patch).length, 1);
});

test("analysis waits for collector enrichment instead of reading and then losing its cache", async () => {
  const state = fixture();
  const entered = deferred(); const release = deferred();
  state.beforeWrite = async patch => {
    if ("body" in patch) { state.beforeWrite = undefined; entered.resolve(); await release.promise; }
  };
  const collection = collectSource(source);
  await entered.promise;
  const reading = prepareStoredArticle(1, cfg);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(state.calls, 0);
  release.resolve();
  await Promise.all([collection, reading]);
  assert.ok(state.article.readingCache?.completedAt);
  assert.equal(state.calls, 2);
  await prepareStoredArticle(1, cfg);
  assert.equal(state.calls, 2);
});

test("refresh preserves completed and partial caches for unchanged body/scope", async () => {
  const state = fixture();
  await collectSource(source);
  state.invoke = async () => { if (state.calls === 2) throw Error("synthetic interrupted reading"); return "완료한 첫 구간"; };
  await assert.rejects(prepareStoredArticle(1, cfg), /synthetic interrupted reading/);
  assert.equal(Object.keys(state.article.readingCache!.chunks).length, 1);
  assert.equal(state.article.readingCache?.completedAt, undefined);
  state.invoke = undefined;
  await prepareStoredArticle(1, cfg, true);
  assert.equal(state.calls, 3, "only the failed second chunk is generated again");
  const complete = structuredClone(state.article.readingCache);
  await prepareStoredArticle(1, cfg, true);
  assert.equal(state.calls, 3);
  assert.deepEqual(state.article.readingCache, complete);
  assert.ok(state.patches.filter(patch => "body" in patch).slice(1).every(patch => !("readingCache" in patch)));
});

test("refresh invalidates a reading when the provider body or collection scope changes", async () => {
  const state = fixture();
  await collectSource(source);
  await prepareStoredArticle(1, cfg);
  const oldKey = state.article.readingCache!.key;
  state.article.sourceBody = body + "\n추가된 결론";
  await prepareStoredArticle(1, cfg, true);
  assert.equal(state.calls, 4);
  assert.notEqual(state.article.readingCache!.key, oldKey);
  assert.match(state.article.body!, /추가된 결론$/);
  state.article.contentMeta = { ...state.article.contentMeta!, status: "partial", reason: "예전 수집 제한" };
  await prepareStoredArticle(1, cfg, true);
  assert.equal(state.calls, 6);
  assert.equal(state.patches.filter(patch => "body" in patch && patch.readingCache === null).length, 3);
});

test("a collector cannot overwrite replacement content or revive a row deleted during enrichment", async () => {
  for (const deleted of [false, true]) {
    const state = fixture();
    state.beforeWrite = async patch => {
      if (!("body" in patch)) return;
      state.beforeWrite = undefined;
      if (deleted) state.article.deletedAt = new Date();
      else { state.article.body = "외부 작업의 새 본문"; state.article.sourceBody = "외부 작업의 새 원문"; }
    };
    assert.equal(await collectSource(source), 1);
    assert.equal(state.calls, 0);
    assert.equal(state.patches.length, 0);
    if (deleted) assert.ok(state.article.deletedAt);
    else assert.equal(state.article.body, "외부 작업의 새 본문");
  }
});

test("a reading interrupted by deletion stops before the next chunk and writes no stale cache", async () => {
  const state = fixture();
  await collectSource(source);
  state.invoke = async () => { state.article.deletedAt = new Date(); return "삭제 중 응답한 구간"; };
  await assert.rejects(prepareStoredArticle(1, cfg), /전체 읽기를 중단/);
  assert.equal(state.calls, 1);
  assert.equal(state.article.readingCache, null);
});

test("a case-only source replacement rejects a stale enrichment snapshot", async () => {
  const state = fixture();
  adapter.fetch = async () => [{ externalId: "race", body: "ABC" }];
  state.beforeWrite = async patch => {
    if (!("body" in patch)) return;
    state.beforeWrite = undefined;
    state.article.body = "abc";
    state.article.sourceBody = "abc";
  };
  assert.equal(await collectSource(source), 1);
  assert.equal(state.article.body, "abc");
  assert.equal(state.article.sourceBody, "abc");
  assert.equal(state.patches.length, 0);
});

test("empty provider bodies retain null snapshot guards and can be prepared", async () => {
  const state = fixture();
  adapter.fetch = async () => [{ externalId: "race" }];
  assert.equal(await collectSource(source), 1);
  assert.equal(state.article.sourceBody, null);
  await prepareStoredArticle(1, cfg);
  assert.equal(state.calls, 0);
  assert.ok(state.article.readingCache?.completedAt);
});

test("explicit refresh releases a reading hold while preserving completed chunks", async () => {
  const state = fixture();
  await collectSource(source);
  await prepareStoredArticle(1, cfg);
  const cache = structuredClone(state.article.readingCache!);
  state.article.readingCache = { ...cache, recovery: { version: 1, splits: { first: true }, calls: 36,
    held: { reason: "recovery_budget", at: "2026-09-22T00:00:00Z" } } };
  await prepareStoredArticle(1, cfg, true);
  assert.equal(state.calls, 2, "reset must not generate paid duplicates of completed chunks");
  assert.deepEqual(state.article.readingCache?.chunks, cache.chunks);
  assert.deepEqual(state.article.readingCache?.recovery?.splits, { first: true });
  assert.equal(state.article.readingCache?.recovery?.calls, 0);
  assert.equal(state.article.readingCache?.recovery?.held, undefined);
});
