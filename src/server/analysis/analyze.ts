import { sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { articles, analyses } from "../db/schema.js";
import type { Article, AnalysisConfig, Impact } from "../db/schema.js";
import { settingsRepo } from "../repo/settings.js";
import {
  complete,
  parseJsonLoose,
  hasLLM,
  FILTER_MODEL,
  ANALYSIS_MODEL,
} from "./anthropic.js";
import { ANALYSIS_OUTPUT_CONTRACT } from "../../shared/analysis.js";

const MAX_BODY_CHARS = 12_000; // cap body length sent to the model
const BATCH = 20; // max articles per analysis pass

function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) : s;
}

/** 1st pass: cheap relevance filter driven by the user's criteria/instructions. */
export async function filterRelevant(
  article: Article,
  cfg: AnalysisConfig,
): Promise<boolean> {
  const criteria = cfg.relevanceCriteria?.trim() || cfg.instructions;
  const system =
    `${criteria}\n\n` +
    `다음 글이 위 기준에 관련 있는지 판단해 JSON으로만 답한다: {"relevant": true} 또는 {"relevant": false}`;
  const user = `제목: ${article.title ?? ""}\n미리보기: ${clip(article.body, 600)}`;
  const text = await complete({
    model: cfg.filterModel || FILTER_MODEL(),
    system,
    user,
    maxTokens: 16,
  });
  const parsed = parseJsonLoose<{ relevant?: boolean }>(text);
  return parsed?.relevant === true;
}

export interface DeepAnalysis {
  summary: string;
  implications: string;
  tickers: string[];
  themes: string[];
  impact: Impact;
}

/** 2nd pass: full structured analysis using the user's instructions as the system prompt. */
export async function deepAnalyze(
  article: Article,
  cfg: AnalysisConfig,
): Promise<DeepAnalysis | null> {
  const system = `${cfg.instructions}\n\n${ANALYSIS_OUTPUT_CONTRACT}`;
  const user =
    `제목: ${article.title ?? ""}\n` +
    `출처: ${article.url ?? ""}\n\n` +
    `본문:\n${clip(article.body, MAX_BODY_CHARS)}`;
  const text = await complete({
    model: cfg.analysisModel || ANALYSIS_MODEL(),
    system,
    user,
    maxTokens: 1024,
  });
  const parsed = parseJsonLoose<Partial<DeepAnalysis>>(text);
  if (!parsed) return null;
  const impact: Impact =
    parsed.impact === "bullish" || parsed.impact === "bearish" ? parsed.impact : "neutral";
  return {
    summary: parsed.summary ?? "",
    implications: parsed.implications ?? "",
    tickers: Array.isArray(parsed.tickers) ? parsed.tickers.map(String) : [],
    themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
    impact,
  };
}

/**
 * Process articles that have no analysis yet. For each: 1st-pass filter; if
 * relevant, 2nd-pass deep analysis. Writes one row to `analyses` per article.
 */
export async function runAnalysis(): Promise<{ analyzed: number; relevant: number; errors: number }> {
  if (!hasDb) {
    console.warn("[analyze] no DATABASE_URL — skipping.");
    return { analyzed: 0, relevant: 0, errors: 0 };
  }
  if (!hasLLM()) {
    console.warn("[analyze] no LLM configured (ANTHROPIC_API_KEY or LLM_BASE_URL+LLM_API_KEY) — skipping.");
    return { analyzed: 0, relevant: 0, errors: 0 };
  }

  const cfg = await settingsRepo.getAnalysisConfig();

  // Articles with no analysis row yet.
  const pending = await db
    .select()
    .from(articles)
    .where(sql`${articles.id} NOT IN (SELECT ${analyses.articleId} FROM ${analyses})`)
    .limit(BATCH);

  let analyzed = 0;
  let relevant = 0;
  let errors = 0;

  for (const article of pending) {
    try {
      const isRelevant = await filterRelevant(article, cfg);
      if (!isRelevant) {
        await db.insert(analyses).values({
          articleId: article.id,
          relevant: false,
          model: cfg.filterModel || FILTER_MODEL(),
        });
        analyzed++;
        continue;
      }
      const deep = await deepAnalyze(article, cfg);
      await db.insert(analyses).values({
        articleId: article.id,
        relevant: true,
        summary: deep?.summary,
        implications: deep?.implications,
        tickers: deep?.tickers ?? [],
        themes: deep?.themes ?? [],
        impact: deep?.impact ?? "neutral",
        model: cfg.analysisModel || ANALYSIS_MODEL(),
      });
      analyzed++;
      relevant++;
    } catch (err) {
      errors++;
      console.error(`[analyze] article ${article.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { analyzed, relevant, errors };
}
