/**
 * Selectable LLM models for the Settings dropdowns and per-call routing.
 *
 * The provider is decided by the model ID: `claude-*` goes to the Anthropic
 * Claude API, anything else to the configured OpenAI-compatible endpoint
 * (DeepSeek). Claude models expose a reasoning "effort" level instead of
 * DeepSeek's thinking ON/OFF switch.
 *
 * Prices are USD per 1M tokens, Anthropic first-party rates checked 2026-11.
 * They are reference estimates for the usage card, never billing-time prices.
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];

export const EFFORT_LABELS: Record<ClaudeEffort, string> = {
  low: "낮음 — 빠르고 저렴",
  medium: "중간",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대 — 가장 깊게 (비용↑)",
};

export type ModelProvider = "anthropic" | "deepseek";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Prompt length (tokens) above which the long-context price applies. */
  longPromptOver?: number;
  longInput?: number;
  longOutput?: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: ModelProvider;
  /** Short hint shown under the dropdown. */
  note: string;
  /** Claude only: supported reasoning effort levels. */
  efforts?: readonly ClaudeEffort[];
  /** Claude only: the API default when no effort is sent. */
  defaultEffort?: ClaudeEffort;
  price?: ModelPrice;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic",
    note: "최종 보고서 권장 · $4 / $20", efforts: CLAUDE_EFFORTS, defaultEffort: "medium",
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  {
    id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic",
    note: "선별·정리 고품질 · $2 / $10", efforts: CLAUDE_EFFORTS, defaultEffort: "high",
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic",
    note: "가장 저렴 · $0.10 / $0.50", efforts: CLAUDE_EFFORTS, defaultEffort: "medium",
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, longPromptOver: 100_000, longInput: 0.5, longOutput: 2.5 },
  },
  {
    id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic",
    note: "가장 강력·가장 비쌈 · $10 / $50", efforts: CLAUDE_EFFORTS, defaultEffort: "high",
    price: { input: 10, output: 50, cacheRead: 0.25 },
  },
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", provider: "deepseek", note: "DeepSeek 저가 · Thinking ON/OFF" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", note: "DeepSeek 상위 · Thinking ON/OFF" },
];

export function isClaudeModel(model: string | undefined | null): boolean {
  return typeof model === "string" && /^claude-/i.test(model.trim());
}

export function modelOption(model: string | undefined | null): ModelOption | undefined {
  const id = model?.trim().toLowerCase();
  return id ? MODEL_OPTIONS.find(option => option.id === id) : undefined;
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

/**
 * Effort actually sent for a Claude model: the configured value when the model
 * supports it, otherwise that model's API default. Undefined for non-Claude models.
 */
export function effortFor(model: string, configured?: ClaudeEffort | null): ClaudeEffort | undefined {
  if (!isClaudeModel(model)) return undefined;
  const option = modelOption(model);
  const supported = option?.efforts ?? CLAUDE_EFFORTS;
  if (configured && supported.includes(configured)) return configured;
  return option?.defaultEffort ?? "high";
}

/** Reference USD cost for known token counts, or null when the model has no price. */
export function claudeCostUsd(
  model: string,
  tokens: { cacheHitTokens: number; cacheMissTokens: number; outputTokens: number },
): number | null {
  const price = modelOption(model)?.price;
  if (!price) return null;
  const { cacheHitTokens: hit, cacheMissTokens: miss, outputTokens: out } = tokens;
  if (![hit, miss, out].every(n => Number.isFinite(n) && n >= 0)) return null;
  return (hit * price.cacheRead + miss * price.input + out * price.output) / 1_000_000;
}

/** The map stage inherits the filter model when unset — and its effort with it. */
export function mapStageEffort(cfg: { digestMapModel?: string; digestMapEffort?: ClaudeEffort; filterEffort?: ClaudeEffort }): ClaudeEffort | undefined {
  return cfg.digestMapEffort ?? (cfg.digestMapModel?.trim() ? undefined : cfg.filterEffort);
}

/** Settings fields that decide the long-article reading stage (sections of bodies over 12,000 chars). */
export interface ReadingStageConfig {
  readingModel?: string; readingEffort?: ClaudeEffort; readingThinking?: "enabled" | "disabled";
  digestMapModel?: string; digestMapEffort?: ClaudeEffort; digestMapThinking?: "enabled" | "disabled";
  filterEffort?: ClaudeEffort;
}

/**
 * Long-article reading model: its own setting, else the 자료 정리 (map) model, else
 * `fallback` (the filter model). Splitting it lets a cheap model do the faithful
 * section-by-section fact extraction while the map keeps a stronger model.
 */
export function readingStageModel(cfg: ReadingStageConfig, fallback: string): string {
  return cfg.readingModel?.trim() || cfg.digestMapModel?.trim() || fallback;
}

/** Reading effort: explicit value, else (only while the model is inherited) the map stage's effort. */
export function readingStageEffort(cfg: ReadingStageConfig): ClaudeEffort | undefined {
  return cfg.readingEffort ?? (cfg.readingModel?.trim() ? undefined : mapStageEffort(cfg));
}

/** DeepSeek Thinking for reading: explicit value, else the map's while the model is inherited, else OFF. */
export function readingStageThinking(cfg: ReadingStageConfig): "enabled" | "disabled" {
  return cfg.readingThinking ?? (cfg.readingModel?.trim() ? "disabled" : cfg.digestMapThinking ?? "disabled");
}
