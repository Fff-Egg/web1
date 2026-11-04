/**
 * Claude API 모델별 요청 규칙 — 순수 함수(환경변수·네트워크 없음).
 *
 * DeepSeek의 Thinking은 모델과 무관한 ON/OFF 스위치 하나였지만 Claude는 세대마다 규칙이 다르고,
 * 틀리면 400이 난다. 앱의 단계별 Thinking ON/OFF를 모델별 요청으로 번역하는 곳을 여기 한 군데로 모은다.
 *  - 4.6 이전 세대(Haiku 4.5 포함): adaptive가 없고 budget_tokens 방식이라 앱은 Thinking 없이 호출한다.
 *  - 생각을 끌 수 없는 모델(Opus 5.5·Fable·Mythos): OFF 요청은 effort low로 낮추고 생각 토큰 여유를 더 준다.
 *  - Sonnet 5.5: `disabled`가 400이라 끄는 값은 `between_tools`다.
 *  - 그 밖의 현행 모델(Haiku 5.5·Sonnet 5·Opus 5·Opus 4.6~4.8·Sonnet 4.6): ON=adaptive, OFF=disabled.
 */

/** 글 선별·자료 정리처럼 호출이 많은 단계의 기본값. DeepSeek Flash 자리. */
export const CLAUDE_BULK_MODEL = "claude-haiku-5-5";
/** 최종 연결·작성처럼 하루 몇 번뿐인 단계의 기본값. DeepSeek Pro 자리. */
export const CLAUDE_FINAL_MODEL = "claude-opus-5-5";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Thinking OFF를 요청했지만 생각을 끌 수 없는 모델에 더해 주는 max_tokens 여유(실사용량만 과금). */
export const CLAUDE_LOW_EFFORT_HEADROOM = 16_384;
/**
 * 호출부의 출력 상한은 DeepSeek 토크나이저 기준으로 맞춰져 있다. Claude는 같은 한국어를 더 많은
 * 토큰으로 센다(Haiku 5.5는 Haiku 4.5보다도 약 30% 많음). 상한은 실제 쓴 만큼만 과금되므로, 잘린
 * 응답을 버리고 다시 부르는 대신 상한 자체를 넉넉히 잡는다. Thinking ON 예산(≥49,152)에는 적용하지 않는다.
 */
export const CLAUDE_TOKENIZER_ALLOWANCE = 1.5;

const id = (model: string) => model.trim().toLowerCase();

export function isClaudeModel(model: string): boolean {
  return id(model).startsWith("claude-");
}

/** Pre-4.6 generations, including Haiku 4.5 and dated snapshots of them. */
export function isLegacyClaudeModel(model: string): boolean {
  const m = id(model);
  return /^claude-(?:instant|2|3)/.test(m) || /^claude-(?:opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?$/.test(m);
}

function alwaysThinks(m: string): boolean {
  return /^claude-(?:opus-5-5|fable-|mythos-)/.test(m);
}

function offIsBetweenTools(m: string): boolean {
  return /^claude-sonnet-5-5/.test(m);
}

/** Server-side refusal fallback (beta) is offered on these; Haiku has none. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(?:opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(id(model));
}

/** Generations with a documented 1M-token context window. */
export function hasMillionTokenContext(model: string): boolean {
  return /^claude-(?:fable-5|mythos-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6|haiku-5)/.test(id(model));
}

export interface ClaudeThinkingRequest {
  thinking?: { type: "adaptive" } | { type: "disabled" } | { type: "between_tools" };
  effort?: ClaudeEffort;
  /** What actually runs, for usage diagnostics. */
  effectiveThinking: "enabled" | "disabled" | "unknown";
  /** Thinking can run although the caller sized max_tokens for the answer only. */
  needsHeadroom: boolean;
}

export function claudeThinkingRequest(
  model: string,
  mode: "enabled" | "disabled" | undefined,
  onEffort: ClaudeEffort = "high",
): ClaudeThinkingRequest {
  const m = id(model);
  if (isLegacyClaudeModel(m)) return { effectiveThinking: "disabled", needsHeadroom: false };
  if (mode === "enabled") {
    return { thinking: { type: "adaptive" }, effort: onEffort, effectiveThinking: "enabled", needsHeadroom: false };
  }
  if (mode === "disabled") {
    if (alwaysThinks(m)) return { effort: "low", effectiveThinking: "enabled", needsHeadroom: true };
    if (offIsBetweenTools(m)) return { thinking: { type: "between_tools" }, effectiveThinking: "disabled", needsHeadroom: false };
    return { thinking: { type: "disabled" }, effectiveThinking: "disabled", needsHeadroom: false };
  }
  // No explicit choice: current generations may think by default, so leave room for it.
  return { effectiveThinking: "unknown", needsHeadroom: true };
}

/** `CLAUDE_THINKING_EFFORT` (Thinking ON 단계의 effort). Invalid values fall back to high. */
export function parseClaudeEffort(value: string | undefined): ClaudeEffort {
  const v = value?.trim().toLowerCase();
  return (CLAUDE_EFFORTS as readonly string[]).includes(v ?? "") ? (v as ClaudeEffort) : "high";
}
