import { and, desc, eq, isNull } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, articles, llmUsage, sources } from "../db/schema.js";
import { contentScope } from "../../shared/articleContent.js";
import { readingDiagnostics, type ArticleAnalysisDiagnostics, type ArticleAnalysisDiagnosticsResponse } from "../../shared/analysisDiagnostics.js";

/** SELECT-only projections: no collection, cache reset, analysis or provider call. */
export function articleDiagnosticQueries(store: Pick<typeof db, "select">, articleId: number) {
  const article = store.select({ id: articles.id, title: articles.title, url: articles.url, provider: sources.provider,
    body: articles.body, sourceBody: articles.sourceBody, contentMeta: articles.contentMeta, readingCache: articles.readingCache,
    analysisId: analyses.id, analyzedAt: analyses.createdAt,
  }).from(articles).leftJoin(sources, eq(articles.sourceId, sources.id))
    .leftJoin(analyses, eq(analyses.articleId, articles.id))
    .where(and(eq(articles.id, articleId), isNull(articles.deletedAt))).limit(1);
  const attempts = store.select({ startedAt: llmUsage.startedAt, stage: llmUsage.stage, model: llmUsage.model,
    thinking: llmUsage.thinking, success: llmUsage.success, durationMs: llmUsage.durationMs,
    httpStatus: llmUsage.httpStatus, finishReason: llmUsage.finishReason,
    errorCategory: llmUsage.errorCategory, errorParam: llmUsage.errorParam,
    inputTokens: llmUsage.inputTokens, outputTokens: llmUsage.outputTokens,
  }).from(llmUsage).where(eq(llmUsage.articleId, articleId)).orderBy(desc(llmUsage.startedAt), desc(llmUsage.id)).limit(30);
  return { article, attempts };
}

type DiagnosticQueries = ReturnType<typeof articleDiagnosticQueries>;
type ArticleRow = Awaited<DiagnosticQueries["article"]>[number];
type AttemptRow = Awaited<DiagnosticQueries["attempts"]>[number];

/** Deliberately enumerate public fields rather than exposing whole DB rows/caches. */
export function articleDiagnosticsFromRows(row: ArticleRow, attempts: AttemptRow[]): ArticleAnalysisDiagnostics {
  const meta = row.contentMeta;
  return {
    id: row.id, title: row.title, url: row.url, provider: row.provider,
    body: row.body ?? "", bodyChars: (row.body ?? "").length, sourceBodyChars: row.sourceBody?.length ?? null,
    content: { scope: contentScope(meta), status: meta?.status ?? null, method: meta?.method ?? null,
      checkedAt: meta?.checkedAt ?? null, pending: meta?.pending ?? false,
      extractedLinks: meta?.links.filter(link => link.status === "extracted").length ?? 0,
      unavailableLinks: meta?.links.filter(link => link.status === "unavailable").length ?? 0 },
    analysis: { completed: row.analysisId !== null, analyzedAt: row.analyzedAt?.toISOString() ?? null },
    reading: readingDiagnostics(row.readingCache),
    attempts: attempts.slice(0, 30).map(attempt => ({
      startedAt: attempt.startedAt.toISOString(), stage: attempt.stage, model: attempt.model, thinking: attempt.thinking,
      success: attempt.success, durationMs: attempt.durationMs, httpStatus: attempt.httpStatus, finishReason: attempt.finishReason,
      errorCategory: attempt.errorCategory, errorParam: attempt.errorParam, inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens,
    })),
  };
}

export async function getArticleAnalysisDiagnostics(articleId: number): Promise<ArticleAnalysisDiagnosticsResponse> {
  if (!hasDb) return { persisted: false, article: null };
  const queries = articleDiagnosticQueries(db, articleId);
  const [article] = await queries.article;
  if (!article) return { persisted: true, article: null };
  return { persisted: true, article: articleDiagnosticsFromRows(article, await queries.attempts) };
}
