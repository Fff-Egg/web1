import { sql, desc, and, isNull } from "drizzle-orm";
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

// Cap body length sent to the model (cuts token cost). Tune via env.
const MAX_BODY_CHARS = Number(process.env.MAX_BODY_CHARS ?? 5_000);
const BATCH = 20; // max articles per analysis pass

/** Rate-limit / quota errors (e.g. Groq free-tier daily token cap). */
function isRateLimit(msg: string): boolean {
  return msg.includes("429") || /rate limit|quota|TPD|tokens per day/i.test(msg);
}

function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) : s;
}

/** Criteria text that means "don't filter — analyze everything". */
function analyzeEverything(criteria: string): boolean {
  if (process.env.ANALYZE_ALL === "1") return true;
  return /^(전부|모두|모든\s*글|all|everything)\.?$/i.test(criteria.trim());
}

export interface Classification {
  relevant: boolean;
  /** Important enough for the main feed; low → sorted into the review bucket. */
  important: boolean;
  /** Short summary of the article (shown in the Feed). Empty if not relevant. */
  summary: string;
}

/**
 * 1st pass — one cheap call that BOTH decides relevance AND summarizes, driven
 * by the user's 1차 지침 (relevanceCriteria: 무엇을 뽑을지 + 어떻게 요약할지).
 */
export async function filterRelevant(
  article: Article,
  cfg: AnalysisConfig,
): Promise<Classification> {
  const criteria = cfg.relevanceCriteria?.trim() || cfg.instructions;
  const summaryGuide = cfg.summaryInstructions?.trim() || "핵심 내용을 한국어 2~3문장으로 요약한다.";
  const importanceGuide =
    cfg.importanceCriteria?.trim() ||
    "단순 잡담·인사·개인 일상·반복·광고는 낮음. 투자 판단·시황·실적·뉴스는 높음.";
  const forceAll = analyzeEverything(criteria);
  const system =
    `[관련성 판단 기준]\n${criteria}\n\n` +
    `[중요도 판단 기준]\n${importanceGuide}\n\n` +
    `[요약 지침]\n${summaryGuide}\n\n` +
    `위 기준으로: (1) 관련 있는지 relevant, (2) 중요한지 important(낮은 중요도/개인적이면 false), ` +
    `(3) 관련 있으면 [요약 지침]대로 summary. ` +
    `JSON 하나로만 답한다: {"relevant": true 또는 false, "important": true 또는 false, "summary": "요약 (관련 없으면 빈 문자열)"}`;
  // Give the summarizer enough of the (possibly batched) body to summarize well.
  const bodyChars = Number(process.env.FILTER_BODY_CHARS ?? 4000);
  const user = `제목: ${article.title ?? ""}\n본문:\n${clip(article.body, bodyChars)}`;
  const text = await complete({
    model: cfg.filterModel || FILTER_MODEL(),
    system,
    user,
    maxTokens: 600,
  });
  const parsed = parseJsonLoose<{ relevant?: boolean; important?: boolean; summary?: string }>(text);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : "";
  // Fail open: unreadable answer keeps the article. "전부"/ANALYZE_ALL forces relevant.
  const relevant = forceAll || !parsed || parsed.relevant !== false;
  // Important unless explicitly false (so nothing is hidden by accident).
  const important = parsed?.important !== false;
  if (!parsed) {
    console.warn(`[analyze] filter unparseable for article ${article.id} — keeping it.`);
  }
  return { relevant, important, summary };
}

export interface DeepAnalysis {
  summary: string;
  implications: string;
  fullText: string;
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
    // Large enough for a full multi-section report in `fullAnalysis`.
    maxTokens: Number(process.env.ANALYSIS_MAX_TOKENS ?? 4096),
  });
  const parsed = parseJsonLoose<Partial<DeepAnalysis> & { fullAnalysis?: string }>(text);
  if (!parsed) return null;
  const impact: Impact =
    parsed.impact === "bullish" || parsed.impact === "bearish" ? parsed.impact : "neutral";
  return {
    summary: parsed.summary ?? "",
    implications: parsed.implications ?? "",
    fullText: parsed.fullAnalysis ?? "",
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

  // Articles with no analysis row yet — newest first, so fresh posts get
  // analyzed before an old backlog (and aren't starved by it).
  const pending = await db
    .select()
    .from(articles)
    .where(
      and(
        sql`${articles.id} NOT IN (SELECT ${analyses.articleId} FROM ${analyses})`,
        isNull(articles.deletedAt),
      ),
    )
    .orderBy(desc(articles.id))
    .limit(BATCH);

  let analyzed = 0;
  let relevant = 0;
  let errors = 0;

  // Per-article deep analysis is off by default — the daily digest does the
  // synthesis. Set DEEP_ANALYSIS=1 to also analyze each article individually.
  const deepPerArticle = process.env.DEEP_ANALYSIS === "1";

  for (const article of pending) {
    try {
      const { relevant: isRelevant, important, summary } = await filterRelevant(article, cfg);
      if (!isRelevant) {
        await db.insert(analyses).values({
          articleId: article.id,
          relevant: false,
          model: cfg.filterModel || FILTER_MODEL(),
        });
        analyzed++;
        continue;
      }
      // 1st-pass pick (with its summary). Deep analysis only when enabled.
      const deep = deepPerArticle ? await deepAnalyze(article, cfg) : null;
      await db.insert(analyses).values({
        articleId: article.id,
        relevant: true,
        lowPriority: !important,
        summary: deep?.summary ?? summary,
        implications: deep?.implications,
        fullText: deep?.fullText,
        tickers: deep?.tickers ?? [],
        themes: deep?.themes ?? [],
        impact: deep?.impact ?? "neutral",
        model: deepPerArticle ? cfg.analysisModel || ANALYSIS_MODEL() : cfg.filterModel || FILTER_MODEL(),
      });
      analyzed++;
      relevant++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[analyze] article ${article.id} failed:`, msg);
      // Hit the provider's rate/quota limit — stop this cycle instead of
      // hammering it with the rest of the batch (each call just re-fails).
      if (isRateLimit(msg)) {
        console.warn("[analyze] rate/quota limit hit — pausing analysis until next cycle.");
        break;
      }
    }
  }

  return { analyzed, relevant, errors };
}
