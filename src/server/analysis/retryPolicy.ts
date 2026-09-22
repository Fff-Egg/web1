import { createHash } from "node:crypto";
import type { AnalysisConfig, Article } from "../db/schema.js";
import type { AnalysisRetryReason } from "../../shared/analysisRetry.js";
import { FILTER_MODEL, ANALYSIS_MODEL, resolveModel } from "./anthropic.js";

export const ANALYSIS_RETRY_VERSION = "2026-09-22-bounded-v1";
export function filterTokenLimit(hasThreads: boolean): number {
  const value = Number(process.env.FILTER_MAX_TOKENS ?? (hasThreads ? 1400 : 600));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : hasThreads ? 1400 : 600;
}
export function correctedFilterTokenLimit(initial: number): number { return Math.max(initial, Math.min(6000, Math.max(1600, initial * 2))); }

export function analysisConfigFingerprint(cfg: AnalysisConfig, hasThreads: boolean): string {
  return createHash("sha256").update(JSON.stringify([
    ANALYSIS_RETRY_VERSION, process.env.LLM_BASE_URL ?? "anthropic", process.env.LLM_EXTRA_BODY ?? "",
    resolveModel(cfg.filterModel || FILTER_MODEL()), resolveModel(cfg.digestMapModel || cfg.filterModel || FILTER_MODEL()),
    resolveModel(cfg.analysisModel || ANALYSIS_MODEL()), cfg.filterThinking ?? "disabled", cfg.digestMapThinking ?? "disabled",
    filterTokenLimit(hasThreads), process.env.ANALYSIS_MAX_TOKENS ?? "4096", process.env.DEEP_ANALYSIS ?? "0",
    cfg.instructions, cfg.relevanceCriteria, cfg.importanceCriteria, cfg.summaryInstructions,
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
  const status = /LLM API (\d{3}):/.exec(message)?.[1];
  if (status === "401" || status === "403") return "authentication";
  if (status === "402") return "balance";
  if (status === "400" || status === "404" || status === "422") return "request_rejected";
  if (status === "429" || /rate limit|quota|TPD|tokens per day/i.test(message)) return "rate_limit";
  return "transient";
}

export function nextAnalysisRetry(attemptsBefore: number, reason: AnalysisRetryReason, now = new Date()) {
  const attempts = attemptsBefore + 1;
  const held = ["output_limit", "reading_held", "request_rejected"].includes(reason) || attempts >= 3;
  const delay = attempts === 1 ? 30 * 60_000 : 2 * 3600_000;
  return { attempts, reason, held, nextRetryAt: held ? null : new Date(now.getTime() + delay), updatedAt: now };
}
export function globalPauseMinutes(reason: AnalysisRetryReason): number {
  return reason === "authentication" || reason === "balance" ? 60 : reason === "rate_limit" ? 30 : 0;
}
