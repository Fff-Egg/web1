import type { ProviderErrorDiagnosis } from "../../shared/providerError.js";

const PARAMS = new Set([
  "model", "max_tokens", "max_completion_tokens", "messages", "messages.content", "messages.role", "messages.reasoning_content",
  "messages.tool_calls", "messages.tool_call_id", "thinking", "thinking.type", "reasoning_effort", "temperature", "top_p",
  "stream", "stream_options", "stream_options.include_usage", "response_format", "response_format.type", "tools", "tool_choice",
  "stop", "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs", "seed", "n",
]);
function safeParam(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const normalized = value.trim().replace(/^messages(?:\[\d{1,3}\]|\.\d{1,3})\./, "messages.");
  return PARAMS.has(normalized) ? normalized : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Inspect only in memory; return fixed labels and an exact allowlisted parameter. */
export function diagnoseProviderError(raw: string, status: number): ProviderErrorDiagnosis {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { /* Some gateways return plain text/HTML. */ }
  const root = object(payload);
  const nested = object(root.error);
  const error = Object.keys(nested).length ? nested : root;
  const param = safeParam(error.param);
  const message = typeof error.message === "string" ? error.message.slice(0, 65_536)
    : typeof root.error === "string" ? root.error.slice(0, 65_536) : payload === undefined ? raw.slice(0, 65_536) : "";
  // Codes can be useful to classify but are untrusted and are not returned/stored.
  const code = typeof error.code === "string" ? error.code.slice(0, 128).toLowerCase() : "";
  const text = `${code} ${message}`.toLowerCase();
  const result = (category: ProviderErrorDiagnosis["category"]): ProviderErrorDiagnosis => ({ category, param });
  if (status === 401) return result("authentication");
  if (status === 402) return result("balance");
  if (status === 429) return result("rate_limit");
  if (/content[_ ](?:filter|policy|exists[_ ]risk|risk)|safety[_ ](?:violation|policy)|moderation|sensitive content|内容.{0,20}风险/u.test(text)) return result("content_policy");
  if (status === 403) return result("authentication");
  if (/authentication[_ ](?:error|failed)|invalid[_ ]api[_ ]key|(?:api[_ ]key|api key).{0,30}(?:invalid|incorrect|missing)/u.test(text)) return result("authentication");
  if (/surrogate|utf[-_ ]?8|unicode|hex escape|(?:invalid|unescaped|disallowed) control character|(?:invalid|unsupported|disallowed|reserved).{0,25}special token/u.test(text)) return result("invalid_unicode");
  if (/context[_ ](?:length|window)|maximum.{0,30}context|too many.{0,20}tokens|(?:input|prompt).{0,40}(?:too long|exceed)|上下文/u.test(text)) return result("context_limit");
  if (param === "stream_options" || param?.startsWith("stream_options.") || /stream_options.{0,100}stream|stream.{0,100}stream_options/u.test(text)) return result("stream_options");
  if (/invalid json|json (?:decode|parse|parsing|syntax)|malformed (?:json|request body)|failed to (?:parse|deserialize)|unexpected (?:end|token|character).{0,30}(?:json|escape)|expected.{0,30}(?:comma|colon|json)/u.test(text)) return result("invalid_json");
  if (/json.{0,80}(?:must|require)|(?:prompt|messages).{0,80}(?:must|require).{0,40}json|json_mode_invalid/u.test(text)) return result("json_requirement");
  if (param === "max_tokens" || param === "max_completion_tokens" || /max[_ ](?:completion[_ ])?tokens.{0,80}(?:invalid|must|between|range|exceed)/u.test(text)) return result("max_tokens");
  if (param === "model" || /model[_ ]not[_ ]found|(?:unknown|invalid|unsupported).{0,15}model|model.{0,70}(?:not exist|not found|not available|not supported|does not exist)/u.test(text)) return result("model");
  if (/unsupported[_ ](?:parameter|param)|unknown[_ ](?:parameter|param)|unrecognized.{0,20}(?:parameter|argument)|(?:parameter|argument|field).{0,60}(?:not supported|unsupported|not allowed|invalid)|extra inputs are not permitted/u.test(text)
    || (param && /not supported|unsupported|not allowed|unknown parameter|unrecognized/u.test(text))) return result("unsupported_parameter");
  if (/insufficient[_ ](?:balance|quota)|balance.{0,20}(?:insufficient|depleted)/u.test(text)) return result("balance");
  if (/rate[_ ]limit|too many requests/u.test(text)) return result("rate_limit");
  return result("unknown");
}

export class LlmProviderError extends Error {
  readonly code = "LLM_PROVIDER_ERROR";
  readonly category: ProviderErrorDiagnosis["category"];
  readonly param: string | null;
  constructor(readonly status: number, diagnosis: ProviderErrorDiagnosis) {
    super(`LLM API ${status}: provider request failed (${diagnosis.category}${diagnosis.param ? `; param=${diagnosis.param}` : ""})`);
    this.name = "LlmProviderError";
    this.category = diagnosis.category; this.param = diagnosis.param;
  }
}
