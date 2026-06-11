import { z } from "zod";
import { and, desc, eq, gte, lt, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { articles, analyses, sources, IMPACTS } from "../../db/schema.js";
import { feedbackRepo } from "../../repo/feedback.js";

const feedSelect = {
  id: articles.id,
  title: articles.title,
  url: articles.url,
  // Only carry the full body for telegram (no original link); keeps the feed light.
  body: sql<string | null>`CASE WHEN ${sources.provider} = 'telegram' THEN ${articles.body} ELSE NULL END`,
  author: articles.author,
  publishedAt: articles.publishedAt,
  addedAt: analyses.createdAt,
  sourceLabel: sources.label,
  provider: sources.provider,
  summary: analyses.summary,
  implications: analyses.implications,
  fullText: analyses.fullText,
  tickers: analyses.tickers,
  themes: analyses.themes,
  impact: analyses.impact,
  lowPriority: analyses.lowPriority,
  saved: analyses.saved,
};

/**
 * feed router — analyzed, relevant, non-trashed articles with their analysis.
 * Supports theme / ticker / impact filtering, plus trash (soft-delete) ops.
 */
export const feedRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          impact: z.enum(IMPACTS).optional(),
          ticker: z.string().optional(),
          theme: z.string().optional(),
          priority: z.enum(["important", "low", "saved"]).default("important"),
          /** Filter to items added to the feed on this KST date (YYYY-MM-DD). */
          date: z.string().optional(),
          limit: z.number().min(1).max(2000).default(500),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      if (!hasDb) return [];
      const conds = [eq(analyses.relevant, true), isNull(articles.deletedAt)];
      // important = main feed, low = review bucket, saved = read-later bucket.
      if (input?.priority === "saved") conds.push(eq(analyses.saved, true));
      else conds.push(eq(analyses.lowPriority, input?.priority === "low"));
      if (input?.impact) conds.push(eq(analyses.impact, input.impact));
      if (input?.ticker)
        conds.push(sql`JSON_CONTAINS(${analyses.tickers}, JSON_QUOTE(${input.ticker}))`);
      if (input?.theme)
        conds.push(sql`JSON_CONTAINS(${analyses.themes}, JSON_QUOTE(${input.theme}))`);
      if (input?.date) {
        const start = new Date(`${input.date}T00:00:00+09:00`);
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        conds.push(gte(analyses.createdAt, start), lt(analyses.createdAt, end));
      }

      return db
        .select(feedSelect)
        .from(analyses)
        .innerJoin(articles, eq(analyses.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(and(...conds))
        .orderBy(desc(analyses.createdAt))
        .limit(input?.limit ?? 100);
    }),

  /** A single feed item by article id, any bucket. Used by the digest's
   *  "피드에서 원문 보기" link (telegram has no viewable original). */
  get: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      if (!hasDb) return null;
      const [row] = await db
        .select(feedSelect)
        .from(analyses)
        .innerJoin(articles, eq(analyses.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(
          and(
            eq(articles.id, input.id),
            eq(analyses.relevant, true),
            isNull(articles.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    }),

  /** Counts per bucket for the tab badges. */
  counts: publicProcedure.query(async () => {
    if (!hasDb) return { important: 0, low: 0, saved: 0 };
    const [row] = await db
      .select({
        important: sql<number>`SUM(CASE WHEN ${analyses.lowPriority} = false THEN 1 ELSE 0 END)`,
        low: sql<number>`SUM(CASE WHEN ${analyses.lowPriority} = true THEN 1 ELSE 0 END)`,
        saved: sql<number>`SUM(CASE WHEN ${analyses.saved} = true THEN 1 ELSE 0 END)`,
      })
      .from(analyses)
      .innerJoin(articles, eq(analyses.articleId, articles.id))
      .where(and(eq(analyses.relevant, true), isNull(articles.deletedAt)));
    return {
      important: Number(row?.important ?? 0),
      low: Number(row?.low ?? 0),
      saved: Number(row?.saved ?? 0),
    };
  }),

  /** Soft-deleted feed items (trash). */
  trash: publicProcedure.query(async () => {
    if (!hasDb) return [];
    return db
      .select(feedSelect)
      .from(analyses)
      .innerJoin(articles, eq(analyses.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(and(eq(analyses.relevant, true), isNotNull(articles.deletedAt)))
      .orderBy(desc(articles.deletedAt))
      .limit(1000);
  }),

  /** Move a feed item to trash (soft delete). User negative signal for the filter. */
  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await feedbackRepo.logArticles([input.id], "negative", "trash");
      await db.update(articles).set({ deletedAt: new Date() }).where(eq(articles.id, input.id));
      return { ok: true };
    }),

  /** Restore from trash. User positive signal (중요↑) — "I want this back". */
  restore: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await feedbackRepo.logArticles([input.id], "positive", "restore");
      await db.update(articles).set({ deletedAt: null }).where(eq(articles.id, input.id));
      return { ok: true };
    }),

  /** Permanently delete (only from trash): drop the analysis + body, but keep a
   *  tombstone row (its url) so collection won't re-create (revive) the item.
   *  No feedback logged — trash mixes user-trashed and auto-swept items. */
  purge: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      const [a] = await db
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.id, input.id), isNotNull(articles.deletedAt)))
        .limit(1);
      if (!a) return { ok: true };
      await db.delete(analyses).where(eq(analyses.articleId, input.id));
      await db.update(articles).set({ body: null }).where(eq(articles.id, input.id));
      return { ok: true };
    }),

  /** Promote a low-importance item into the main feed. User positive signal. */
  promote: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await feedbackRepo.logArticles([input.id], "positive", "promote");
      await db.update(analyses).set({ lowPriority: false }).where(eq(analyses.articleId, input.id));
      return { ok: true };
    }),

  /** Toggle "saved / read later" on a feed item. */
  setSaved: publicProcedure
    .input(z.object({ id: z.number(), saved: z.boolean() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(analyses).set({ saved: input.saved }).where(eq(analyses.articleId, input.id));
      return { ok: true };
    }),

  // ── Batch ops (multi-select) ──────────────────────────────────────
  deleteMany: publicProcedure
    .input(z.object({ ids: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      if (!hasDb || input.ids.length === 0) return { ok: true };
      await feedbackRepo.logArticles(input.ids, "negative", "trash");
      await db.update(articles).set({ deletedAt: new Date() }).where(inArray(articles.id, input.ids));
      return { ok: true };
    }),
  restoreMany: publicProcedure
    .input(z.object({ ids: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      if (!hasDb || input.ids.length === 0) return { ok: true };
      await feedbackRepo.logArticles(input.ids, "positive", "restore");
      await db.update(articles).set({ deletedAt: null }).where(inArray(articles.id, input.ids));
      return { ok: true };
    }),
  purgeMany: publicProcedure
    .input(z.object({ ids: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      if (!hasDb || input.ids.length === 0) return { ok: true };
      const rows = await db
        .select({ id: articles.id })
        .from(articles)
        .where(and(inArray(articles.id, input.ids), isNotNull(articles.deletedAt)));
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return { ok: true };
      await db.delete(analyses).where(inArray(analyses.articleId, ids));
      await db.update(articles).set({ body: null }).where(inArray(articles.id, ids));
      return { ok: true };
    }),
  /** Empty the feed trash — tombstone each (drop analysis + body, keep the row for dedup). */
  purgeAll: publicProcedure.mutation(async () => {
    if (!hasDb) return { ok: true };
    const rows = await db.select({ id: articles.id }).from(articles).where(isNotNull(articles.deletedAt));
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { ok: true };
    await db.delete(analyses).where(inArray(analyses.articleId, ids));
    await db.update(articles).set({ body: null }).where(isNotNull(articles.deletedAt));
    return { ok: true };
  }),
});
