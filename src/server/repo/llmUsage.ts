import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { llmUsage as u } from "../db/schema.js";
import type { LlmUsageBucket, LlmUsageEvent, LlmUsageFailureGroup, LlmUsageRepeatedArticle, LlmUsageReport } from "../../shared/llmUsage.js";

const usageDay = sql<string>`DATE_FORMAT(DATE_ADD(${u.startedAt}, INTERVAL 9 HOUR), '%Y-%m-%d')`;
const priced = sql`${u.cacheHitTokens} IS NOT NULL AND ${u.cacheMissTokens} IS NOT NULL AND ${u.outputTokens} IS NOT NULL`;
const costFields = {
  pricedRequests: sql<number>`SUM(${priced})`,
  pricedHit: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.cacheHitTokens} ELSE 0 END)`,
  pricedMiss: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.cacheMissTokens} ELSE 0 END)`,
  pricedOutput: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.outputTokens} ELSE 0 END)`,
};

/** Only metadata already in the ledger. Never join article text, titles or credentials. */
export function failureUsageQueries(store: Pick<typeof db, "select">, since: Date, until: Date) {
  const failedInRange = and(gte(u.startedAt, since), lte(u.startedAt, until), eq(u.success, false));
  const failures = store.select({
    day: usageDay, stage: u.stage, model: u.model, endpointHost: u.endpointHost, thinking: u.thinking,
    httpStatus: u.httpStatus, finishReason: u.finishReason,
    requests: sql<number>`COUNT(*)`, outputKnown: sql<number>`COUNT(${u.outputTokens})`,
    outputTokens: sql<number | null>`SUM(${u.outputTokens})`, ...costFields,
  }).from(u).where(failedInRange)
    .groupBy(usageDay, u.stage, u.model, u.endpointHost, u.thinking, u.httpStatus, u.finishReason);
  const repeated = store.select({
    articleId: u.articleId, stage: u.stage, httpStatus: u.httpStatus, finishReason: u.finishReason,
    failures: sql<number>`COUNT(*)`,
    // MySQL sessions are UTC. Emit an explicit timezone, independent of the browser's locale.
    lastAt: sql<string>`DATE_FORMAT(MAX(${u.startedAt}), '%Y-%m-%dT%H:%i:%sZ')`,
  }).from(u).where(and(failedInRange, isNotNull(u.articleId)))
    .groupBy(u.articleId, u.stage, u.httpStatus, u.finishReason)
    .having(sql`COUNT(*) > 1`)
    .orderBy(desc(sql`COUNT(*)`), desc(sql`MAX(${u.startedAt})`), u.articleId, u.stage, u.httpStatus, u.finishReason)
    .limit(20);
  return { failures, repeated };
}

type CostRow = { pricedRequests: number | string; pricedHit: number | string; pricedMiss: number | string; pricedOutput: number | string };
function costBasis(row: CostRow): LlmUsageBucket["costBasis"] {
  return { requests: Number(row.pricedRequests), cacheHitTokens: Number(row.pricedHit), cacheMissTokens: Number(row.pricedMiss), outputTokens: Number(row.pricedOutput) };
}

/** MySQL aggregates may arrive as decimal strings; preserve unknown SUMs as null. */
export function failureGroupFromRow(row: Omit<LlmUsageFailureGroup, "costBasis" | "requests" | "outputKnown" | "outputTokens"> & CostRow & {
  requests: number | string; outputKnown: number | string; outputTokens: number | string | null;
}): LlmUsageFailureGroup {
  return { day: row.day, stage: row.stage, model: row.model, endpointHost: row.endpointHost, thinking: row.thinking,
    httpStatus: row.httpStatus, finishReason: row.finishReason, requests: Number(row.requests), outputKnown: Number(row.outputKnown),
    outputTokens: row.outputTokens === null ? null : Number(row.outputTokens), costBasis: costBasis(row) };
}

export function repeatedArticleFromRow(row: Omit<LlmUsageRepeatedArticle, "articleId" | "failures"> & {
  articleId: number | string | null; failures: number | string;
}): LlmUsageRepeatedArticle {
  return { articleId: Number(row.articleId), stage: row.stage, httpStatus: row.httpStatus, finishReason: row.finishReason,
    failures: Number(row.failures), lastAt: row.lastAt };
}

export async function saveLlmUsageEvent(event: LlmUsageEvent): Promise<void> {
  if (!hasDb) throw Error("usage_store_unconfigured");
  // Stable attempt IDs make a delayed observer safe to reconcile with fallback logs.
  await db.insert(u).values({ ...event, startedAt: new Date(event.startedAt) })
    .onDuplicateKeyUpdate({ set: { requestId: event.requestId } });
}

export function usageDateRange(now: Date): { since: Date; until: Date } {
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  return { since: new Date(new Date(`${day}T00:00:00+09:00`).getTime() - 6 * 86400_000), until: now };
}

/** Last seven KST calendar dates, aggregated in SQL so the response stays small. */
export async function getLlmUsageReport(now = new Date()): Promise<LlmUsageReport> {
  const { since, until } = usageDateRange(now);
  const report: LlmUsageReport = { timezone: "Asia/Seoul", since: since.toISOString(), until: until.toISOString(),
    generatedAt: now.toISOString(), persisted: hasDb, rows: [], failureGroups: [], repeatedArticles: [] };
  if (!hasDb) return report;
  const queries = failureUsageQueries(db, since, until);
  const buckets = db.select({
    day: usageDay, stage: u.stage, model: u.model, endpointHost: u.endpointHost, thinking: u.thinking,
    requests: sql<number>`COUNT(*)`, succeeded: sql<number>`SUM(${u.success} = 1)`, failed: sql<number>`SUM(${u.success} = 0)`,
    unknownUsage: sql<number>`SUM(${u.inputTokens} IS NULL OR ${u.outputTokens} IS NULL)`,
    inputTokens: sql<number | null>`SUM(${u.inputTokens})`, cacheHitTokens: sql<number | null>`SUM(${u.cacheHitTokens})`,
    cacheMissTokens: sql<number | null>`SUM(${u.cacheMissTokens})`, outputTokens: sql<number | null>`SUM(${u.outputTokens})`,
    reasoningTokens: sql<number | null>`SUM(${u.reasoningTokens})`,
    inputKnown: sql<number>`COUNT(${u.inputTokens})`, cacheHitKnown: sql<number>`COUNT(${u.cacheHitTokens})`,
    cacheMissKnown: sql<number>`COUNT(${u.cacheMissTokens})`, outputKnown: sql<number>`COUNT(${u.outputTokens})`,
    reasoningKnown: sql<number>`COUNT(${u.reasoningTokens})`,
    ...costFields,
  }).from(u).where(and(gte(u.startedAt, since), lte(u.startedAt, until)))
    .groupBy(usageDay, u.stage, u.model, u.endpointHost, u.thinking);
  const [rows, failureRows, repeatedRows] = await Promise.all([buckets, queries.failures, queries.repeated]);
  report.rows = rows.map(row => {
    const { pricedRequests, pricedHit, pricedMiss, pricedOutput, ...rest } = row;
    const bucket = { ...rest } as LlmUsageBucket;
    for (const key of ["requests", "succeeded", "failed", "unknownUsage", "inputTokens", "cacheHitTokens", "cacheMissTokens", "outputTokens", "reasoningTokens", "inputKnown", "cacheHitKnown", "cacheMissKnown", "outputKnown", "reasoningKnown"] as const) {
      Object.assign(bucket, { [key]: rest[key] === null ? null : Number(rest[key]) });
    }
    bucket.costBasis = costBasis({ pricedRequests, pricedHit, pricedMiss, pricedOutput });
    return bucket;
  }).sort((a, b) => b.day.localeCompare(a.day) || a.stage.localeCompare(b.stage));
  report.failureGroups = failureRows.map(failureGroupFromRow)
    .sort((a, b) => b.day.localeCompare(a.day) || b.requests - a.requests || a.stage.localeCompare(b.stage));
  report.repeatedArticles = repeatedRows.map(repeatedArticleFromRow);
  return report;
}
