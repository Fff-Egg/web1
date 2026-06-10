import { z } from "zod";
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { articles, analyses, sources, IMPACTS } from "../../db/schema.js";

const feedSelect = {
  id: articles.id,
  title: articles.title,
  url: articles.url,
  // Only carry the full body for telegram (no original link); keeps the feed light.
  body: sql<string | null>`CASE WHEN ${sources.provider} = 'telegram' THEN ${articles.body} ELSE NULL END`,
  author: articles.author,
  publishedAt: articles.publishedAt,
  sourceLabel: sources.label,
  provider: sources.provider,
  summary: analyses.summary,
  implications: analyses.implications,
  fullText: analyses.fullText,
  tickers: analyses.tickers,
  themes: analyses.themes,
  impact: analyses.impact,
  lowPriority: analyses.lowPriority,
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
          priority: z.enum(["important", "low"]).default("important"),
          limit: z.number().min(1).max(2000).default(500),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      if (!hasDb) return [];
      const conds = [eq(analyses.relevant, true), isNull(articles.deletedAt)];
      // Main feed = important; "low" = the review bucket.
      conds.push(eq(analyses.lowPriority, input?.priority === "low"));
      if (input?.impact) conds.push(eq(analyses.impact, input.impact));
      if (input?.ticker)
        conds.push(sql`JSON_CONTAINS(${analyses.tickers}, JSON_QUOTE(${input.ticker}))`);
      if (input?.theme)
        conds.push(sql`JSON_CONTAINS(${analyses.themes}, JSON_QUOTE(${input.theme}))`);

      return db
        .select(feedSelect)
        .from(analyses)
        .innerJoin(articles, eq(analyses.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(and(...conds))
        .orderBy(desc(articles.publishedAt))
        .limit(input?.limit ?? 100);
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

  /** Move a feed item to trash (soft delete). */
  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(articles).set({ deletedAt: new Date() }).where(eq(articles.id, input.id));
      return { ok: true };
    }),

  /** Restore from trash. */
  restore: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(articles).set({ deletedAt: null }).where(eq(articles.id, input.id));
      return { ok: true };
    }),

  /** Permanently delete (only from trash). Cascades the analysis row. */
  purge: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.delete(articles).where(and(eq(articles.id, input.id), isNotNull(articles.deletedAt)));
      return { ok: true };
    }),

  /** Promote a low-importance item into the main feed. */
  promote: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(analyses).set({ lowPriority: false }).where(eq(analyses.articleId, input.id));
      return { ok: true };
    }),
});
