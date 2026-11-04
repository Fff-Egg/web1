import { createHash } from "node:crypto";
import type { AnalysisConfig, Article } from "../db/schema.js";
import type { AnalysisRetryReason } from "../../shared/analysisRetry.js";
import { FILTER_MODEL, ANALYSIS_MODEL, resolveModel } from "./anthropic.js";
import { mapStageEffort, readingStageEffort, readingStageModel, readingStageThinking } from "../../shared/llmModels.js";

export const ANALYSIS_RETRY_VERSION = "2026-09-22-compact-reading-v2";
export function filterTokenLimit(hasThreads: boolean): number {
  // Full article evidence and thesis fields need room to close the JSON. This
  // is a ceiling, not a request to generate this many tokens.
  const fallback = hasThreads ? 2800 : 1600;
  const value = Number(process.env.FILTER_MAX_TOKENS ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export function correctedFilterTokenLimit(initial: number): number { return Math.max(initial, Math.min(6000, Math.max(1600, initial * 2))); }

export function analysisConfigFingerprint(cfg: AnalysisConfig, hasThreads: boolean): string {
  // Long-article reading enters the fingerprint only when its EFFECTIVE setup differs
  // from the 자료 정리 (map) setup it otherwise inherits: unset fields, or saved values
  // equal to the inherited ones, keep fingerprints (and so existing holds) unchanged.
  const filterModelId = cfg.filterModel || FILTER_MODEL();
  const reading = [resolveModel(readingStageModel(cfg, filterModelId)), readingStageEffort(cfg) ?? "", readingStageThinking(cfg)];
  const inherited = [resolveModel(cfg.digestMapModel || filterModelId), mapStageEffort(cfg) ?? "", cfg.digestMapThinking ?? "disabled"];
  const readingDiffers = reading.some((value, i) => value !== inherited[i]);
  return createHash("sha256").update(JSON.stringify([
    ANALYSIS_RETRY_VERSION, process.env.LLM_BASE_URL ?? "anthropic", process.env.LLM_EXTRA_BODY ?? "",
    resolveModel(cfg.filterModel || FILTER_MODEL()), resolveModel(cfg.digestMapModel || cfg.filterModel || FILTER_MODEL()),
    resolveModel(cfg.analysisModel || ANALYSIS_MODEL()), cfg.filterThinking ?? "disabled", cfg.digestMapThinking ?? "disabled",
    cfg.filterEffort ?? "", cfg.digestMapEffort ?? "",
    filterTokenLimit(hasThreads), process.env.ANALYSIS_MAX_TOKENS ?? "4096", process.env.DEEP_ANALYSIS ?? "0",
    cfg.instructions, cfg.relevanceCriteria, cfg.importanceCriteria, cfg.summaryInstructions,
    ...(readingDiffers ? [["reading", ...reading]] : []),
  ])).digest("hex");
}

/** Length-prefix UTF-8 fields, matching articleContentFingerprintSql exactly. */
export function articleContentFingerprint(article: Pick<Article, "body" | "sourceBody" | "title" | "url" | "contentMeta">): string {
  const parts = [article.body, article.sourceBody, article.title, article.url, article.contentMeta?.checkedAt].map(value => value ?? "");
  return createHash("sha256").update(parts.map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("")).digest("hex");
}

export function analysisFailureReason(error: unknown): AnalysisRetryReason {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "WHOLE_READING_HELD") return "reading_held";
  if (code === "LLM_OUTPUT_LIMIT" || /finish_reason=length/.test(message)) return "output_limit";
  // Provider category first: Claude reports exhausted credits as HTTP 400.
  const category = error && typeof error === "object" && "category" in error ? String(error.category) : "";
  if (category === "balance") return "balance";
  if (category === "authentication") return "authentication";
  if (category === "overloaded") return "overloaded";
  // Per-request refusals stay per-article (held), even when a gateway sends them as 403.
  if (category === "content_policy") return "request_rejected";
  const status = /LLM API (\d{3}):/.exec(message)?.[1];
  if (status === "401" || status === "403") return "authentication";
  if (status === "402") return "balance";
  if (status === "400" || status === "404" || status === "422") return "request_rejected";
  if (status === "429" || /rate limit|quota|TPD|tokens per day/i.test(message)) return "rate_limit";
  return "transient";
}

/**
 * Account/provider-wide failures: the whole batch already waits on the global
 * pause, and the article itself did nothing wrong. Refund the reserved attempt
 * so days of exhausted credit (one probe every 6h) never hold healthy articles.
 * These requests are rejected before any work, or (mid-stream overload) rare.
 * rate_limit is deliberately NOT here: one oversized request can exceed the
 * per-minute input bucket on every try, and only the hold-after-3 bounds it.
 */
const PROVIDER_WIDE_REASONS: ReadonlySet<AnalysisRetryReason> = new Set(["balance", "authentication", "overloaded"]);

export function nextAnalysisRetry(attemptsBefore: number, reason: AnalysisRetryReason, now = new Date()) {
  if (PROVIDER_WIDE_REASONS.has(reason)) return { attempts: attemptsBefore, reason, held: false, nextRetryAt: null, updatedAt: now };
  const attempts = attemptsBefore + 1;
  const held = ["output_limit", "reading_held", "request_rejected"].includes(reason) || attempts >= 3;
  const delay = attempts === 1 ? 30 * 60_000 : 2 * 3600_000;
  return { attempts, reason, held, nextRetryAt: held ? null : new Date(now.getTime() + delay), updatedAt: now };
}
export function globalPauseMinutes(reason: AnalysisRetryReason): number {
  // Exhausted credits only return next billing cycle (or after a manual top-up and
  // "해제"). Re-check every 6h: a rejected request is not billed.
  if (reason === "balance") return 360;
  // Overload is short-lived; a brief pause keeps the batch from hammering a busy API.
  return reason === "authentication" ? 60 : reason === "rate_limit" ? 30 : reason === "overloaded" ? 15 : 0;
}
