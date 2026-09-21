import { and, eq, isNull, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { articles, sources, type Article, type AnalysisConfig } from "../db/schema.js";
import { enrichArticle } from "../adapters/fullText.js";
import { readWholeArticle } from "../analysis/fullReading.js";
import { FILTER_MODEL } from "../analysis/anthropic.js";
import { contentScope } from "../../shared/articleContent.js";

const jobs = new Map<number, Promise<unknown>>();
class ContentChangedError extends Error {}
/** Collection, filter and digest must share the same extraction/checkpoint lock. */
async function withArticleContent<T>(id: number, run: () => Promise<T>): Promise<T> {
  const prior = jobs.get(id);
  const task = (async () => {
    if (prior) await prior.catch(() => {});
    return run();
  })();
  jobs.set(id, task);
  try { return await task; } finally { if (jobs.get(id) === task) jobs.delete(id); }
}

/** Also reject writes after deletion or content replacement outside this process. */
function contentSnapshot(article: Article) {
  return and(eq(articles.id, article.id), isNull(articles.deletedAt),
    article.body === null ? isNull(articles.body) : sql`BINARY ${articles.body} = BINARY ${article.body}`,
    article.sourceBody === null ? isNull(articles.sourceBody) : sql`BINARY ${articles.sourceBody} = BINARY ${article.sourceBody}`,
    article.contentMeta === null ? isNull(articles.contentMeta)
      : sql`JSON_UNQUOTE(JSON_EXTRACT(${articles.contentMeta}, '$.checkedAt')) = ${article.contentMeta.checkedAt}`);
}

// Caller holds withArticleContent; do not reacquire it here (reading holds it too).
async function enrichCurrentArticle(id: number, refresh = false): Promise<Article | null> {
  if (!hasDb) throw Error("본문 저장소가 연결되지 않았습니다.");
  const [row] = await db.select({ article: articles, source: sources }).from(articles)
    .innerJoin(sources, eq(articles.sourceId, sources.id)).where(and(eq(articles.id, id), isNull(articles.deletedAt))).limit(1);
  if (!row) return null;
  const article = row.article;
  // Analysis may have finished enriching/reading while this collection waited.
  if (article.contentMeta && !article.contentMeta.pending && !refresh) return article;
  const sourceBody = article.sourceBody ?? article.body;
  const enriched = await enrichArticle({ ...article, body: sourceBody, contentMeta: article.contentMeta ?? undefined,
    linkedUrls: article.contentMeta?.sourceUrls, externalId: article.externalId }, row.source);
  const changed = (enriched.body ?? null) !== article.body || contentScope(enriched.contentMeta) !== contentScope(article.contentMeta);
  // Omit the cache column entirely for unchanged content. Never copy an old
  // snapshot over a newer partial or completed reading checkpoint.
  const patch = { body: enriched.body ?? null, sourceBody, contentMeta: enriched.contentMeta!, ...(changed ? { readingCache: null } : {}) };
  const result = await db.update(articles).set(patch).where(contentSnapshot(article));
  if (!result[0].affectedRows) throw new ContentChangedError("원문이 변경되었거나 휴지통으로 이동했습니다. 다시 시도해 주세요.");
  return { ...article, ...patch };
}

/** Enrich a newly collected row without invoking the LLM or discarding a reading. */
export async function enrichStoredArticle(id: number): Promise<void> {
  try {
    await withArticleContent(id, () => enrichCurrentArticle(id));
  } catch (error) {
    // A user deleting a row or another worker replacing it must not stop
    // enrichment of the remaining successfully collected source items.
    if (!(error instanceof ContentChangedError)) throw error;
  }
}

export async function prepareStoredArticle(id: number, cfg: AnalysisConfig, refresh = false): Promise<{ article: Article; text: string }> {
  return withArticleContent(id, async () => {
    const article = await enrichCurrentArticle(id, refresh);
    if (!article) throw Error("원문이 없거나 휴지통으로 이동했습니다.");
    const reading = await readWholeArticle({ body: article.body ?? "", meta: article.contentMeta,
      articleId: id,
      model: cfg.digestMapModel || cfg.filterModel || FILTER_MODEL(), thinking: cfg.digestMapThinking ?? "disabled",
      instructions: cfg.summaryInstructions, cache: article.readingCache,
      checkpoint: async readingCache => {
        const result = await db.update(articles).set({ readingCache }).where(contentSnapshot(article));
        if (!result[0].affectedRows) throw Error("원문이 변경되었거나 휴지통으로 이동해 전체 읽기를 중단했습니다.");
      },
    });
    return { article: { ...article, readingCache: reading },
      text: `[수집 범위] ${contentScope(article.contentMeta)}\n[읽기 범위] ${reading.chunkCount > 1 ? `수집된 본문 ${reading.inputChars}자를 ${reading.chunkCount}개 구간으로 모두 읽은 요약` : "수집된 본문 전체"}. 수집 제한 자체는 원문 신뢰도나 2차 전언 여부의 근거가 아니다.\n\n${reading.text ?? ""}` };
  });
}
