import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { filterFeedback, articles, analyses, sources } from "../db/schema.js";
import type { FeedbackAction, FilterExample } from "../db/schema.js";
import { settingsRepo } from "./settings.js";

/** Max few-shot examples per class injected into the 1st-pass filter. */
const FEWSHOT_MAX = (): number => Number(process.env.FILTER_FEWSHOT_MAX ?? 20);

type Signal = "positive" | "negative";

/**
 * Feedback log for tuning the 1st-pass filter. Only USER actions write here
 * (trash/purge = negative, promote/rescue = positive); the system's 21:00 feed
 * sweep does not, so auto-cleanup never becomes a training signal.
 */
export const feedbackRepo = {
  /** Snapshot the given articles' title/summary/source and append feedback rows. */
  async logArticles(ids: number[], signal: Signal, action: FeedbackAction): Promise<void> {
    if (!hasDb || ids.length === 0) return;
    try {
      const snaps = await db
        .select({
          id: articles.id,
          title: articles.title,
          summary: analyses.summary,
          source: sources.label,
        })
        .from(articles)
        .leftJoin(analyses, eq(analyses.articleId, articles.id))
        .leftJoin(sources, eq(articles.sourceId, sources.id))
        .where(inArray(articles.id, ids));
      if (snaps.length === 0) return;
      await db.insert(filterFeedback).values(
        snaps.map((s) => ({
          articleId: s.id,
          signal,
          action,
          title: s.title ?? null,
          summary: s.summary ?? null,
          source: s.source ?? null,
        })),
      );
    } catch (err) {
      console.error("[feedback] logArticles failed:", err instanceof Error ? err.message : err);
    }
  },

  /** Append one explicit feedback row (e.g. rescue, where summary is a body snippet). */
  async logOne(entry: {
    articleId: number;
    signal: Signal;
    action: FeedbackAction;
    title: string | null;
    summary: string | null;
    source: string | null;
  }): Promise<void> {
    if (!hasDb) return;
    try {
      await db.insert(filterFeedback).values(entry);
    } catch (err) {
      console.error("[feedback] logOne failed:", err instanceof Error ? err.message : err);
    }
  },

  /** Rebuild the few-shot example set (settings) from recent feedback. Runs once a day. */
  async refreshExamples(): Promise<{ negative: number; positive: number }> {
    if (!hasDb) return { negative: 0, positive: 0 };
    const max = FEWSHOT_MAX();
    const pick = async (signal: Signal): Promise<FilterExample[]> => {
      const rows = await db
        .select({ title: filterFeedback.title, summary: filterFeedback.summary })
        .from(filterFeedback)
        .where(eq(filterFeedback.signal, signal))
        // strong negatives (purge) first, then most recent
        .orderBy(
          sql`CASE WHEN ${filterFeedback.action} = 'purge' THEN 0 ELSE 1 END`,
          desc(filterFeedback.createdAt),
        )
        .limit(max * 3); // overfetch, then dedupe by title down to `max`
      const seen = new Set<string>();
      const out: FilterExample[] = [];
      for (const r of rows) {
        const title = (r.title ?? "").trim();
        if (!title) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title, summary: (r.summary ?? "").trim().slice(0, 200) });
        if (out.length >= max) break;
      }
      return out;
    };
    const negative = await pick("negative");
    const positive = await pick("positive");
    await settingsRepo.setFilterExamples({ negative, positive, updatedAt: new Date().toISOString() });
    return { negative: negative.length, positive: positive.length };
  },
};
