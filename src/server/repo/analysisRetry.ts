import { and, eq, isNull, or, lte, sql, desc } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, analysisRetries as retries, articles, settings, type Article } from "../db/schema.js";
import type { AnalysisRetryPause, AnalysisRetryStatus } from "../../shared/analysisRetry.js";
import { analysisConfigFingerprint, articleContentFingerprint, analysisFailureReason, globalPauseMinutes, nextAnalysisRetry } from "../analysis/retryPolicy.js";
import { settingsRepo } from "./settings.js";
import { thesisRepo } from "./thesis.js";
import { resetStoredReadingRecovery } from "./articleContent.js";

const PAUSE_KEY = "analysisRetryPause";
export function articleContentFingerprintSql() {
  const fields = [articles.body, articles.sourceBody, articles.title, articles.url,
    sql`JSON_UNQUOTE(JSON_EXTRACT(${articles.contentMeta}, '$.checkedAt'))`];
  const chunks = fields.map(field => sql`OCTET_LENGTH(COALESCE(${field}, '')), ':', COALESCE(${field}, '')`);
  return sql<string>`SHA2(CONCAT(${sql.join(chunks, sql`, `)}), 256)`;
}
/** Join only the retry for the exact input/configuration; changed inputs become eligible. */
export function matchingAnalysisRetry(configKey: string) {
  return and(eq(retries.articleId, articles.id), eq(retries.configKey, configKey), eq(retries.contentKey, articleContentFingerprintSql()));
}
export function analysisRetryEligible(now = new Date()) {
  return or(isNull(retries.articleId), and(eq(retries.held, false), or(isNull(retries.nextRetryAt), lte(retries.nextRetryAt, now))));
}
function pendingArticles() { return and(isNull(articles.deletedAt), sql`${articles.id} NOT IN (SELECT ${analyses.articleId} FROM ${analyses})`); }

export async function getAnalysisPause(now = new Date()): Promise<AnalysisRetryPause | null> {
  if (!hasDb) return null;
  const [row] = await db.select().from(settings).where(eq(settings.key, PAUSE_KEY)).limit(1);
  const value = row?.value as unknown as AnalysisRetryPause | undefined;
  return value && typeof value.until === "string" && new Date(value.until).getTime() > now.getTime() ? value : null;
}

async function matchingState(article: Article, configKey: string) {
  const [row] = await db.select().from(retries).where(and(eq(retries.articleId, article.id), eq(retries.configKey, configKey), eq(retries.contentKey, articleContentFingerprint(article)))).limit(1);
  return row;
}
/** Reserve before any paid work: interrupted processes still consume an attempt. */
export async function reserveAnalysisAttempt(article: Article, configKey: string) {
  const previous = await matchingState(article, configKey);
  const attempts = (previous?.attempts ?? 0) + 1;
  if (attempts > 3) throw Error("자동 분석 재시도 횟수를 소진했습니다.");
  const patch = { articleId: article.id, configKey, contentKey: articleContentFingerprint(article), attempts,
    reason: previous?.reason ?? "transient" as const, held: attempts >= 3,
    nextRetryAt: attempts >= 3 ? null : new Date(Date.now() + 30 * 60_000), filterCorrected: previous?.filterCorrected ?? false, updatedAt: new Date() };
  await db.insert(retries).values(patch).onDuplicateKeyUpdate({ set: patch });
  return { attempts, filterCorrected: patch.filterCorrected };
}
export async function markAnalysisFilterCorrection(article: Article, configKey: string): Promise<void> {
  const previous = await matchingState(article, configKey);
  const patch = { articleId: article.id, configKey, contentKey: articleContentFingerprint(article), attempts: previous?.attempts ?? 0,
    reason: previous?.reason ?? "output_limit" as const, held: previous?.held ?? false, nextRetryAt: previous?.nextRetryAt ?? null, filterCorrected: true, updatedAt: new Date() };
  await db.insert(retries).values(patch).onDuplicateKeyUpdate({ set: patch });
}

/** A storage error propagates: stop the batch rather than repeat unbounded paid calls. */
export async function recordAnalysisFailure(article: Article, configKey: string, error: unknown, filterCorrected: boolean, reservedAttempts = 0) {
  const previous = await matchingState(article, configKey);
  const reason = analysisFailureReason(error);
  const patch = { articleId: article.id, configKey, contentKey: articleContentFingerprint(article),
    ...nextAnalysisRetry(reservedAttempts ? reservedAttempts - 1 : previous?.attempts ?? 0, reason), filterCorrected: filterCorrected || previous?.filterCorrected || false };
  await db.insert(retries).values(patch).onDuplicateKeyUpdate({ set: patch });
  const minutes = globalPauseMinutes(reason);
  if (minutes) {
    const value = { reason, until: new Date(Date.now() + minutes * 60_000).toISOString() };
    await db.insert(settings).values({ key: PAUSE_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  }
  return { reason, stopBatch: minutes > 0 };
}
export async function clearAnalysisFailure(articleId: number): Promise<void> {
  await db.delete(retries).where(eq(retries.articleId, articleId));
}

export async function getAnalysisRetryStatus(now = new Date()): Promise<AnalysisRetryStatus> {
  const empty: AnalysisRetryStatus = { persisted: hasDb, totalPending: 0, eligible: 0, held: 0, waiting: 0, globalPause: null, items: [] };
  if (!hasDb) return empty;
  const [cfg, threads, globalPause] = await Promise.all([settingsRepo.getAnalysisConfig(), thesisRepo.listBrief(), getAnalysisPause(now)]);
  const configKey = analysisConfigFingerprint(cfg, threads.length > 0);
  const [counts] = await db.select({
    totalPending: sql<number>`COUNT(*)`,
    held: sql<number>`COALESCE(SUM(${retries.held} = 1), 0)`,
    waiting: sql<number>`COALESCE(SUM(${retries.held} = 0 AND ${retries.nextRetryAt} > ${now}), 0)`,
  }).from(articles).leftJoin(retries, matchingAnalysisRetry(configKey)).where(pendingArticles());
  const items = await db.select({ articleId: articles.id, title: articles.title, reason: retries.reason, attempts: retries.attempts,
    held: retries.held, nextRetryAt: retries.nextRetryAt, updatedAt: retries.updatedAt })
    .from(articles).innerJoin(retries, matchingAnalysisRetry(configKey)).where(and(pendingArticles(), or(eq(retries.held, true), sql`${retries.nextRetryAt} > ${now}`)))
    .orderBy(desc(retries.held), desc(retries.updatedAt)).limit(20);
  const totalPending = Number(counts?.totalPending ?? 0), held = Number(counts?.held ?? 0), waiting = Number(counts?.waiting ?? 0);
  return { persisted: true, totalPending, eligible: globalPause ? 0 : totalPending - held - waiting, held, waiting, globalPause,
    items: items.map(item => ({ ...item, nextRetryAt: item.nextRetryAt?.toISOString() ?? null, updatedAt: item.updatedAt.toISOString() })) };
}

/** Explicit operator action only. Clears holds/counters, keeps all completed reading chunks. */
export async function resetAnalysisRetry(articleId?: number, opts: { preservePause?: boolean } = {}): Promise<{ reset: number }> {
  if (!hasDb) return { reset: 0 };
  const rows = await db.select({ id: articles.id }).from(articles).where(and(pendingArticles(), articleId === undefined ? undefined : eq(articles.id, articleId),
    or(sql`${articles.id} IN (SELECT ${retries.articleId} FROM ${retries})`, sql`JSON_EXTRACT(${articles.readingCache}, '$.recovery.held') IS NOT NULL`)));
  for (const row of rows) {
    await resetStoredReadingRecovery(row.id);
    await clearAnalysisFailure(row.id);
  }
  if (!opts.preservePause) await db.delete(settings).where(eq(settings.key, PAUSE_KEY));
  return { reset: rows.length };
}
