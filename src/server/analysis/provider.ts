/**
 * 어떤 LLM API를 쓰는지 — 환경변수만 읽는다(다른 모듈을 import하지 않아 순환 참조가 없다).
 *
 * `LLM_PROVIDER=anthropic`(또는 `claude`)이면 DeepSeek 변수(LLM_BASE_URL·LLM_API_KEY)가 Railway에
 * 남아 있어도 Claude API를 쓴다. 변수를 비우면 예전 규칙 그대로다 — OpenAI 호환 엔드포인트가
 * 설정돼 있으면 그쪽, 아니면 ANTHROPIC_API_KEY. 되돌릴 때는 LLM_PROVIDER만 지우면 된다.
 */
export type LlmProvider = "openai-compatible" | "anthropic" | "unconfigured";

export function anthropicForced(): boolean {
  const value = process.env.LLM_PROVIDER?.trim().toLowerCase();
  return value === "anthropic" || value === "claude";
}

/** True when an OpenAI-compatible endpoint (DeepSeek / Groq / OpenRouter / Ollama …) handles calls. */
export function usingOpenAI(): boolean {
  if (anthropicForced()) return false;
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
}

/** Non-secret runtime provider label for the Settings diagnostics card. */
export function llmProvider(): LlmProvider {
  if (usingOpenAI()) return "openai-compatible";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "unconfigured";
}

/** Whether analysis can run — either Anthropic OR an OpenAI-compatible endpoint. */
export function hasLLM(): boolean {
  return llmProvider() !== "unconfigured";
}

/** Endpoint identity for retry fingerprints. Unchanged for existing OpenAI-compatible deployments. */
export function llmEndpointKey(): string {
  return usingOpenAI() ? process.env.LLM_BASE_URL ?? "anthropic" : "anthropic";
}
