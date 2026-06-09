import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { articles, analyses, sources, IMPACTS } from "../../db/schema.js";

/**
 * feed router — analyzed, relevant articles with their analysis, joined to the
 * source. Supports theme / ticker / impact filtering for the Feed view.
 */
export const feedRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          impact: z.enum(IMPACTS).optional(),
          ticker: z.string().optional(),
          theme: z.string().optional(),
          limit: z.number().min(1).max(200).default(100),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      if (!hasDb) return [];
      const conds = [eq(analyses.relevant, true)];
      if (input?.impact) conds.push(eq(analyses.impact, input.impact));
      if (input?.ticker)
        conds.push(sql`JSON_CONTAINS(${analyses.tickers}, JSON_QUOTE(${input.ticker}))`);
      if (input?.theme)
        conds.push(sql`JSON_CONTAINS(${analyses.themes}, JSON_QUOTE(${input.theme}))`);

      return db
        .select({
          id: articles.id,
          title: articles.title,
          url: articles.url,
          author: articles.author,
          publishedAt: articles.publishedAt,
          sourceLabel: sources.label,
          provider: sources.provider,
          summary: analyses.summary,
          implications: analyses.implications,
          tickers: analyses.tickers,
          themes: analyses.themes,
          impact: analyses.impact,
        })
        .from(analyses)
        .innerJoin(articles, eq(analyses.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(and(...conds))
        .orderBy(desc(articles.publishedAt))
        .limit(input?.limit ?? 100);
    }),
});
