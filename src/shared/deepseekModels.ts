/**
 * DeepSeek V4.1 Flash uses the public ID `deepseek-flash`; legacy V4 IDs
 * remain compatible. Version-pattern recognition does not assert availability.
 */
export function isDeepSeekV4Model(model: string): boolean {
  return /^deepseek-flash$/i.test(model) || /^deepseek-v4(?:\.1)?-(?:flash|pro)(?:$|-)/i.test(model);
}

/** The official endpoint uses one thinking protocol across model names.
 * Known names also support existing OpenAI-compatible proxy deployments. */
export function supportsDeepSeekThinking(baseUrl: string | undefined, model: string): boolean {
  try {
    if (baseUrl && new URL(baseUrl).hostname === "api.deepseek.com") return true;
  } catch { /* Invalid URLs are reported by the request path. */ }
  return isDeepSeekV4Model(model);
}

export type ThinkingMode = "enabled" | "disabled";
export const THINKING_TOKEN_FLOOR = 49_152;

/** Thinking and prose share a cap; preserve larger explicit limits. */
export function thinkingTokenBudget(regularMaxTokens: number, mode: ThinkingMode | undefined, requested = THINKING_TOKEN_FLOOR): number {
  const regular = Number.isFinite(regularMaxTokens) && regularMaxTokens > 0 ? regularMaxTokens : 8192;
  const thinking = Number.isFinite(requested) && requested > 0 ? requested : THINKING_TOKEN_FLOOR;
  return mode === "enabled" ? Math.max(regular, THINKING_TOKEN_FLOOR, thinking) : regular;
}
