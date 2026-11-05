import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Read only explicitly supplied counts. Never infer cache misses or reasoning from characters. */
export function recordProviderUsage(diagnostics: LlmCallDiagnostics, usage: unknown): void {
  const u = object(usage);
  const promptDetails = object(u.prompt_tokens_details);
  const completionDetails = object(u.completion_tokens_details);
  const values = {
    promptTokens: tokenCount(u.prompt_tokens), completionTokens: tokenCount(u.completion_tokens),
    cacheHitTokens: tokenCount(u.prompt_cache_hit_tokens) ?? tokenCount(promptDetails.cached_tokens),
    cacheMissTokens: tokenCount(u.prompt_cache_miss_tokens),
    reasoningTokens: tokenCount(completionDetails.reasoning_tokens) ?? tokenCount(u.reasoning_tokens),
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) Object.assign(diagnostics, { [key]: value });
}
