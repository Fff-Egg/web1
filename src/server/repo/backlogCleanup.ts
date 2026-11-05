import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, articles, settings } from "../db/schema.js";
import type { BacklogCleanup, BacklogCleanupPreview } from "../../shared/analysisRetry.js";

const LAST_CLEANUP_KEY = "analysisBacklogCleanup";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** KST midnight of the given date (articles collected before it are the backlog). */
export function kstMidnight(date: string): Date {
  if (!DATE_RE.test(date)) throw new Error("날짜 형식은 YYYY-MM-DD 여야 합니다.");
  const at = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(at.getTime())) throw new Error("올바른 날짜가 아닙니다.");
  return at;
}

const unanalyzed = () => and(isNull(articles.deletedAt), sql`${articles.id} NOT IN (SELECT ${analyses.articleId} FROM ${analyses})`);

/** Read-only counts for the confirmation dialog; never calls the LLM. */
export async function previewBacklogCleanup(date: string): Promise<BacklogCleanupPreview> {
  const cutoff = kstMidnight(date);
  if (!hasDb) return { date, cutoff: cutoff.toISOString(), before: 0, kept: 0 };
  const [row] = await db.select({
    before: sql<number>`COALESCE(SUM(${articles.fetchedAt} < ${cutoff}), 0)`,
    kept: sql<number>`COALESCE(SUM(${articles.fetchedAt} >= ${cutoff}), 0)`,
  }).from(articles).where(unanalyzed());
  return { date, cutoff: cutoff.toISOString(), before: Number(row?.before ?? 0), kept: Number(row?.kept ?? 0) };
}

/**
 * Explicit operator action: move every still-unanalyzed article collected before the
 * KST date to the trash. They leave the analysis queue (no LLM call, no digest), stay
 * in the DB so collection does not re-add them, and are tombstoned by 「휴지통 비우기」.
 * Already analyzed articles are never touched. The batch shares one deletedAt second,
 * which makes the last cleanup undoable.
 */
export async function trashUnanalyzedBefore(date: string): Promise<BacklogCleanup> {
  const cutoff = kstMidnight(date);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  if (!hasDb) return { date, cutoff: cutoff.toISOString(), at: at.toISOString(), trashed: 0 };
  const result = await db.update(articles).set({ deletedAt: at })
    .where(and(unanalyzed(), lt(articles.fetchedAt, cutoff)));
  const value: BacklogCleanup = { date, cutoff: cutoff.toISOString(), at: at.toISOString(), trashed: Number(result[0].affectedRows ?? 0) };
  const stored = { ...value } as Record<string, unknown>;
  await db.insert(settings).values({ key: LAST_CLEANUP_KEY, value: stored }).onDuplicateKeyUpdate({ set: { value: stored } });
  return value;
}

export async function getLastBacklogCleanup(): Promise<BacklogCleanup | null> {
  if (!hasDb) return null;
  const [row] = await db.select().from(settings).where(eq(settings.key, LAST_CLEANUP_KEY)).limit(1);
  const value = row?.value as unknown as BacklogCleanup | undefined;
  return value && typeof value.at === "string" ? value : null;
}

/** Undo the last cleanup: restores only still-unanalyzed rows trashed in that exact batch. */
export async function undoLastBacklogCleanup(): Promise<{ restored: number }> {
  const last = await getLastBacklogCleanup();
  if (!hasDb || !last) return { restored: 0 };
  const result = await db.update(articles).set({ deletedAt: null }).where(and(
    eq(articles.deletedAt, new Date(last.at)),
    sql`${articles.id} NOT IN (SELECT ${analyses.articleId} FROM ${analyses})`,
  ));
  await db.delete(settings).where(eq(settings.key, LAST_CLEANUP_KEY));
  return { restored: Number(result[0].affectedRows ?? 0) };
}
