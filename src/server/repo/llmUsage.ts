import { and, gte, lte, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { llmUsage as u } from "../db/schema.js";
import type { LlmUsageBucket, LlmUsageEvent, LlmUsageReport } from "../../shared/llmUsage.js";

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
    generatedAt: now.toISOString(), persisted: hasDb, rows: [] };
  if (!hasDb) return report;
  const day = sql<string>`DATE_FORMAT(DATE_ADD(${u.startedAt}, INTERVAL 9 HOUR), '%Y-%m-%d')`;
  const priced = sql`${u.cacheHitTokens} IS NOT NULL AND ${u.cacheMissTokens} IS NOT NULL AND ${u.outputTokens} IS NOT NULL`;
  const rows = await db.select({
    day, stage: u.stage, model: u.model, endpointHost: u.endpointHost, thinking: u.thinking,
    requests: sql<number>`COUNT(*)`, succeeded: sql<number>`SUM(${u.success} = 1)`, failed: sql<number>`SUM(${u.success} = 0)`,
    unknownUsage: sql<number>`SUM(${u.inputTokens} IS NULL OR ${u.outputTokens} IS NULL)`,
    inputTokens: sql<number | null>`SUM(${u.inputTokens})`, cacheHitTokens: sql<number | null>`SUM(${u.cacheHitTokens})`,
    cacheMissTokens: sql<number | null>`SUM(${u.cacheMissTokens})`, outputTokens: sql<number | null>`SUM(${u.outputTokens})`,
    reasoningTokens: sql<number | null>`SUM(${u.reasoningTokens})`,
    inputKnown: sql<number>`COUNT(${u.inputTokens})`, cacheHitKnown: sql<number>`COUNT(${u.cacheHitTokens})`,
    cacheMissKnown: sql<number>`COUNT(${u.cacheMissTokens})`, outputKnown: sql<number>`COUNT(${u.outputTokens})`,
    reasoningKnown: sql<number>`COUNT(${u.reasoningTokens})`,
    pricedRequests: sql<number>`SUM(${priced})`,
    pricedHit: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.cacheHitTokens} ELSE 0 END)`,
    pricedMiss: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.cacheMissTokens} ELSE 0 END)`,
    pricedOutput: sql<number>`SUM(CASE WHEN ${priced} THEN ${u.outputTokens} ELSE 0 END)`,
  }).from(u).where(and(gte(u.startedAt, since), lte(u.startedAt, until)))
    .groupBy(day, u.stage, u.model, u.endpointHost, u.thinking);
  report.rows = rows.map(row => {
    const { pricedRequests, pricedHit, pricedMiss, pricedOutput, ...rest } = row;
    const bucket = { ...rest } as LlmUsageBucket;
    for (const key of ["requests", "succeeded", "failed", "unknownUsage", "inputTokens", "cacheHitTokens", "cacheMissTokens", "outputTokens", "reasoningTokens", "inputKnown", "cacheHitKnown", "cacheMissKnown", "outputKnown", "reasoningKnown"] as const) {
      Object.assign(bucket, { [key]: rest[key] === null ? null : Number(rest[key]) });
    }
    bucket.costBasis = { requests: Number(pricedRequests), cacheHitTokens: Number(pricedHit), cacheMissTokens: Number(pricedMiss), outputTokens: Number(pricedOutput) };
    return bucket;
  }).sort((a, b) => b.day.localeCompare(a.day) || a.stage.localeCompare(b.stage));
  return report;
}
