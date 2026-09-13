import { and, eq, isNull } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { articles, sources, type Article, type AnalysisConfig } from "../db/schema.js";
import { enrichArticle } from "../adapters/fullText.js";
import { readWholeArticle } from "../analysis/fullReading.js";
import { FILTER_MODEL } from "../analysis/anthropic.js";
import { contentScope } from "../../shared/articleContent.js";

const jobs = new Map<number, Promise<unknown>>();
/** Serialize each article's extraction/checkpoints even when filter and digest overlap. */
export async function prepareStoredArticle(id: number, cfg: AnalysisConfig, refresh = false): Promise<{ article: Article; text: string }> {
  const prior = jobs.get(id);
  const task = (async () => {
    if (prior) await prior.catch(() => {});
    if (!hasDb) throw Error("본문 저장소가 연결되지 않았습니다.");
    const [row] = await db.select({ article: articles, source: sources }).from(articles)
      .innerJoin(sources, eq(articles.sourceId, sources.id)).where(and(eq(articles.id, id), isNull(articles.deletedAt))).limit(1);
    if (!row) throw Error("원문이 없거나 휴지통으로 이동했습니다.");
    let article = row.article;
    if (!article.contentMeta || article.contentMeta.pending || refresh) {
      const sourceBody = article.sourceBody ?? article.body;
      const enriched = await enrichArticle({ ...article, body: sourceBody, contentMeta: article.contentMeta ?? undefined,
        linkedUrls: article.contentMeta?.sourceUrls, externalId: article.externalId }, row.source);
      const changed = (enriched.body ?? null) !== article.body || contentScope(enriched.contentMeta) !== contentScope(article.contentMeta);
      const patch = { body: enriched.body ?? null, sourceBody, contentMeta: enriched.contentMeta!, readingCache: changed ? null : article.readingCache };
      await db.update(articles).set(patch).where(and(eq(articles.id, id), isNull(articles.deletedAt)));
      article = { ...article, ...patch };
    }
    const reading = await readWholeArticle({ body: article.body ?? "", meta: article.contentMeta,
      model: cfg.digestMapModel || cfg.filterModel || FILTER_MODEL(), thinking: cfg.digestMapThinking ?? "disabled",
      instructions: cfg.summaryInstructions, cache: article.readingCache,
      checkpoint: async readingCache => { await db.update(articles).set({ readingCache }).where(and(eq(articles.id, id), isNull(articles.deletedAt))); },
    });
    return { article: { ...article, readingCache: reading },
      text: `[수집 범위] ${contentScope(article.contentMeta)}\n[읽기 범위] ${reading.chunkCount > 1 ? `수집된 본문 ${reading.inputChars}자를 ${reading.chunkCount}개 구간으로 모두 읽은 요약` : "수집된 본문 전체"}. 수집 제한 자체는 원문 신뢰도나 2차 전언 여부의 근거가 아니다.\n\n${reading.text ?? ""}` };
  })();
  jobs.set(id, task);
  try { return await task; } finally { if (jobs.get(id) === task) jobs.delete(id); }
}
