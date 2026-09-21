/** A paid attempt, not a feed item. Missing provider usage is never treated as zero. */
export const LLM_USAGE_STAGES = ["filter", "whole_reading", "digest_map", "digest_final", "digest_fallback", "feedback", "deep_analysis", "research_summary", "unknown"] as const;
export type LlmUsageStage = typeof LLM_USAGE_STAGES[number];
export type LlmThinking = "enabled" | "disabled" | "unknown";
export interface LlmUsageContext { stage: LlmUsageStage; articleId?: number; runId?: string }
export interface LlmUsageEvent {
  requestId: string; startedAt: string; stage: LlmUsageStage; model: string;
  endpointHost: string | null; thinking: LlmThinking; articleId: number | null; runId: string | null;
  success: boolean; durationMs: number; finishReason: string | null; httpStatus: number | null;
  inputTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null;
  outputTokens: number | null; reasoningTokens: number | null;
}
export interface LlmUsageBucket {
  day: string; stage: LlmUsageStage; model: string; endpointHost: string | null; thinking: LlmThinking;
  requests: number; succeeded: number; failed: number; unknownUsage: number;
  inputTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null;
  outputTokens: number | null; reasoningTokens: number | null;
  inputKnown: number; cacheHitKnown: number; cacheMissKnown: number; outputKnown: number; reasoningKnown: number;
  /** Only attempts with all three billing quantities supplied by the provider. */
  costBasis: { requests: number; cacheHitTokens: number; cacheMissTokens: number; outputTokens: number };
}
export interface LlmUsageReport {
  timezone: "Asia/Seoul"; since: string; until: string; generatedAt: string; persisted: boolean;
  rows: LlmUsageBucket[];
}
