import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { articles, analyses, sources, IMPACTS } from "../../db/schema.js";

/**
 * Manual analysis flow (no API key needed — for Claude Max users):
 *  - `pending` lists collected articles that have no analysis yet, with body.
 *  - the client builds a paste-block for claude.ai, the user pastes the JSON
 *    answer back, and `save` stores it as an analysis (model="manual").
 */
export const manualRouter = router({
  pending: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(30) }).optional())
    .query(async ({ input }) => {
      if (!hasDb) return [];
      return db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          body: articles.body,
          publishedAt: articles.publishedAt,
          sourceLabel: sources.label,
          provider: sources.provider,
        })
        .from(articles)
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .leftJoin(analyses, eq(analyses.articleId, articles.id))
        .where(and(isNull(analyses.id), isNull(articles.deletedAt)))
        .orderBy(desc(articles.publishedAt))
        .limit(input?.limit ?? 30);
    }),

  /** Count of articles still needing analysis (for a badge). */
  pendingCount: publicProcedure.query(async () => {
    if (!hasDb) return 0;
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(articles)
      .leftJoin(analyses, eq(analyses.articleId, articles.id))
      .where(and(isNull(analyses.id), isNull(articles.deletedAt)));
    return Number(row?.n ?? 0);
  }),

  save: publicProcedure
    .input(
      z.object({
        articleId: z.number(),
        summary: z.string(),
        implications: z.string(),
        fullText: z.string().optional(),
        tickers: z.array(z.string()),
        themes: z.array(z.string()),
        impact: z.enum(IMPACTS),
      }),
    )
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db
        .insert(analyses)
        .values({
          articleId: input.articleId,
          relevant: true,
          summary: input.summary,
          implications: input.implications,
          fullText: input.fullText,
          tickers: input.tickers,
          themes: input.themes,
          impact: input.impact,
          model: "manual",
        })
        .onDuplicateKeyUpdate({
          set: {
            relevant: true,
            summary: input.summary,
            implications: input.implications,
            fullText: input.fullText,
            tickers: input.tickers,
            themes: input.themes,
            impact: input.impact,
            model: "manual",
          },
        });
      return { ok: true };
    }),

  /** Mark an article as not relevant without analyzing it (skip). */
  skip: publicProcedure
    .input(z.object({ articleId: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db
        .insert(analyses)
        .values({ articleId: input.articleId, relevant: false, model: "manual" })
        .onDuplicateKeyUpdate({ set: { relevant: false, model: "manual" } });
      return { ok: true };
    }),
});
