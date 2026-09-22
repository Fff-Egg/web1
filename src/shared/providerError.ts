/** Finite diagnostic labels. Provider messages/codes are never copied into stored metadata. */
export const PROVIDER_ERROR_CATEGORIES = [
  "context_limit", "max_tokens", "model", "unsupported_parameter", "stream_options", "json_requirement",
  "invalid_unicode", "invalid_json", "content_policy", "authentication", "balance", "rate_limit", "unknown",
] as const;
export type ProviderErrorCategory = typeof PROVIDER_ERROR_CATEGORIES[number];
export interface ProviderErrorDiagnosis { category: ProviderErrorCategory; param: string | null }
