import {
  complete,
  resolveModel,
  type CompleteOpts,
} from "../analysis/anthropic.js";

export type DigestModelStage = "map" | "final";
export type DigestFailureKind =
  | "thinking_only_empty"
  | "token_limit"
  | "rate_limit"
  | "authentication"
  | "timeout"
  | "network"
  | "content_filter"
  | "provider_5xx"
  | "bad_request"
  | "empty_response"
  | "unknown";

export interface ModelAttemptFailure {
  /** Attempt number within this stage, including a fallback attempt. */
  attempt: number;
  phase: "initial" | "retry" | "fallback";
  model: string;
  maxTokens?: number;
  thinking?: CompleteOpts["thinking"];
  kind: DigestFailureKind;
  /** Sanitized and truncated provider detail. Never contains prompts or API keys. */
  detail: string;
  at: string;
}

/**
 * Stage-specific DeepSeek policy:
 * - article filter / map compression / Flash fallback: thinking OFF (cost control)
 * - final Pro synthesis: thinking ON (cross-article reasoning quality)
 *
 * `DIGEST_PRO_THINKING=0` is the emergency kill switch. Other providers are
 * left untouched because their thinking controls are not API-compatible.
 */
export function digestThinkingMode(
  model: string,
  stage: DigestModelStage,
): CompleteOpts["thinking"] {
  const resolved = resolveModel(model);
  if (!/^deepseek-v4-(?:flash|pro)(?:$|-)/i.test(resolved)) return undefined;
  if (
    stage === "final" &&
    /^deepseek-v4-pro(?:$|-)/i.test(resolved) &&
    process.env.DIGEST_PRO_THINKING !== "0"
  ) {
    return "enabled";
  }
  return "disabled";
}

export const DIGEST_PRO_THINKING_TOKEN_FLOOR = 49_152;

/** One shared calculator keeps the execution path and Settings preview aligned.
 * A stale Railway 24,576 override must not silently shrink the new one-shot call. */
export function digestFinalTokenBudget(
  model: string,
  regularMaxTokens: number,
  requestedThinkingTokens = DIGEST_PRO_THINKING_TOKEN_FLOOR,
): number {
  const regular = Number.isFinite(regularMaxTokens) && regularMaxTokens > 0 ? regularMaxTokens : 8192;
  const requested = Number.isFinite(requestedThinkingTokens) && requestedThinkingTokens > 0
    ? requestedThinkingTokens
    : DIGEST_PRO_THINKING_TOKEN_FLOOR;
  return digestThinkingMode(model, "final") === "enabled"
    ? Math.max(regular, DIGEST_PRO_THINKING_TOKEN_FLOOR, requested)
    : regular;
}

export interface StageModelTrace {
  /** Value selected by Settings/env before provider compatibility remapping. */
  configured: string;
  /** Model id actually planned for the active provider. */
  planned: string;
  /** Models that successfully returned content, in first-success order. */
  used: string[];
  /** All provider attempts, including failed calls. */
  attempts: number;
  /** Same-model retry attempts. */
  retries: number;
  /** Successful calls made with the emergency fallback model. */
  fallbacks: number;
  /** Units that exhausted every attempt (a map chunk, or the final report). */
  failures: number;
  /** Per-attempt diagnostics retained in digest metadata for UI inspection. */
  errors: ModelAttemptFailure[];
}

/** Stored in digests.meta.models. Top-level legacy fields remain for old UI/code. */
export interface ModelTrace {
  version: 2;
  /** Searchable correlation id printed in Railway logs and saved with the digest. */
  runId: string;
  startedAt: string;
  /** Backward-compatible alias for the effective final synthesis model. */
  primary: string;
  /** Backward-compatible union of models that successfully produced content. */
  used: string[];
  /** Backward-compatible total successful emergency fallbacks. */
  fallbacks: number;
  /** Backward-compatible total exhausted units. */
  failures: number;
  stages: {
    map: StageModelTrace;
    final: StageModelTrace;
  };
}

export type DigestCleanupBlockReason =
  | "trace_missing"
  | "final_fallback"
  | "final_incomplete"
  | "map_incomplete";

/**
 * The 07시 boundary sweep is destructive, so a merely "saved" digest is not
 * enough.  It is safe only when the configured final model itself completed
 * and every map chunk survived.  A Flash emergency result remains readable,
 * but deliberately keeps the source feed for inspection/re-generation.
 */
export type DigestCleanupGate =
  | { eligible: true; reason: "primary_final_success" }
  | { eligible: false; reason: DigestCleanupBlockReason };

export function digestCleanupGate(trace: ModelTrace | null | undefined): DigestCleanupGate {
  if (!trace || trace.version !== 2) return { eligible: false, reason: "trace_missing" };
  const { map, final } = trace.stages;
  if (final.fallbacks > 0) return { eligible: false, reason: "final_fallback" };
  if (final.failures > 0 || !final.used.includes(final.planned)) {
    return { eligible: false, reason: "final_incomplete" };
  }
  if (map.failures > 0) return { eligible: false, reason: "map_incomplete" };
  return { eligible: true, reason: "primary_final_success" };
}

function newStage(configured: string): StageModelTrace {
  return {
    configured,
    planned: resolveModel(configured),
    used: [],
    attempts: 0,
    retries: 0,
    fallbacks: 0,
    failures: 0,
    errors: [],
  };
}

export function newModelTrace(mapModel: string, finalModel: string): ModelTrace {
  const map = newStage(mapModel);
  const final = newStage(finalModel);
  return {
    version: 2,
    runId: `dg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    primary: final.planned,
    used: [],
    fallbacks: 0,
    failures: 0,
    stages: { map, final },
  };
}

function syncTotals(trace: ModelTrace): void {
  trace.used = [];
  for (const model of [...trace.stages.map.used, ...trace.stages.final.used]) {
    if (!trace.used.includes(model)) trace.used.push(model);
  }
  trace.fallbacks = trace.stages.map.fallbacks + trace.stages.final.fallbacks;
  trace.failures = trace.stages.map.failures + trace.stages.final.failures;
}

function noteSuccess(trace: ModelTrace, stage: DigestModelStage, model: string, fallback: boolean): void {
  const step = trace.stages[stage];
  if (!step.used.includes(model)) step.used.push(model);
  if (fallback) step.fallbacks++;
  syncTotals(trace);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorDetail(err: unknown): string {
  const primary = message(err);
  if (!(err instanceof Error) || !err.cause) return primary;
  const cause = err.cause;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const causeCode =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";
  const suffix = [causeCode, causeMessage].filter(Boolean).join(": ");
  return suffix && suffix !== primary ? `${primary}; cause=${suffix}` : primary;
}

function safeFailureDetail(err: unknown): string {
  return errorDetail(err)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-<redacted>")
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token)\s*[=:]\s*)[^\s,}]+/gi, "$1<redacted>")
    .slice(0, 900);
}

export function classifyDigestFailure(err: unknown): DigestFailureKind {
  const detail = errorDetail(err);
  if (/LLM 빈 응답/i.test(detail) && /reasoning_len=[1-9]\d*/i.test(detail) && !/finish_reason=length/i.test(detail)) {
    return "thinking_only_empty";
  }
  if (/finish_reason=length|응답 잘림|maximum context|max(?:imum)?[_ ]tokens/i.test(detail)) return "token_limit";
  if (/429|rate[ _-]?limit|quota|TPD|tokens per day/i.test(detail)) return "rate_limit";
  if (/\b(?:401|403)\b|unauthorized|forbidden|authentication|invalid api key/i.test(detail)) return "authentication";
  if (/content_filter|content filter/i.test(detail)) return "content_filter";
  if (/timeout|timed out|aborterror|aborted/i.test(detail)) return "timeout";
  if (/fetch failed|terminated|und_err_socket|socket (?:closed|hang up)|other side closed|econnreset|enotfound|eai_again|network/i.test(detail)) {
    return "network";
  }
  if (/LLM API 5\d\d/i.test(detail)) return "provider_5xx";
  if (/LLM API 4\d\d/i.test(detail)) return "bad_request";
  if (/LLM 빈 응답|empty response/i.test(detail)) return "empty_response";
  return "unknown";
}

function noteFailure(
  trace: ModelTrace,
  stage: DigestModelStage,
  phase: ModelAttemptFailure["phase"],
  opts: CompleteOpts,
  err: unknown,
): void {
  const step = trace.stages[stage];
  step.errors.push({
    attempt: step.attempts,
    phase,
    model: resolveModel(opts.model),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    kind: classifyDigestFailure(err),
    detail: safeFailureDetail(err),
    at: new Date().toISOString(),
  });
}

function starved(err: unknown): boolean {
  const detail = message(err);
  const reasoningLength = Number(detail.match(/reasoning_len=(\d+)/)?.[1] ?? 0);
  return (
    /finish_reason=length/.test(detail) ||
    (/LLM 빈 응답/.test(detail) && reasoningLength > 0)
  );
}

export type CompleteFn = (opts: CompleteOpts) => Promise<string>;

export interface DigestCallPolicy {
  stage: DigestModelStage;
  /** Emergency model used after the planned model has exhausted its allowed attempts. */
  fallbackModel?: string;
  /** Override thinking for the emergency fallback (normally Flash = disabled). */
  fallbackThinking?: CompleteOpts["thinking"];
  /** Token budget for the fallback model (normally the non-thinking final budget). */
  fallbackMaxTokens?: number;
  /** False = one primary attempt, then immediate fallback. Defaults to true for map resilience. */
  retryPrimary?: boolean;
  /** Token budget for a same-model retry after output exhaustion. */
  retryMaxTokens?: number;
}

/**
 * Digest call policy:
 *   1. planned model
 *   2. either immediate emergency fallback, or one same-model retry when enabled
 *
 * Map calls keep one Flash retry so a transient chunk failure does not create a
 * hole. Final Pro calls set retryPrimary=false: one expensive Thinking attempt,
 * then Flash immediately, with the Pro failure retained in trace.errors.
 */
export async function completeDigestStage(
  opts: CompleteOpts,
  policy: DigestCallPolicy,
  trace: ModelTrace,
  invoke: CompleteFn = complete,
): Promise<string> {
  const step = trace.stages[policy.stage];
  const primary = resolveModel(opts.model);
  const initial = { ...opts, model: primary };
  const invokeFallback = async (
    failure: unknown,
    baseOpts: CompleteOpts,
    failedPrimaryAttempts: number,
  ): Promise<string> => {
    const fallback = policy.fallbackModel ? resolveModel(policy.fallbackModel) : "";
    if (!fallback || fallback === primary) {
      step.failures++;
      syncTotals(trace);
      throw failure;
    }
    step.attempts++;
    console.warn(
      `[digest:${trace.runId}] ${policy.stage} ${primary} ` +
        (failedPrimaryAttempts === 1
          ? `실패 — 같은 모델 재시도 없이 ${fallback} 폴백`
          : `${failedPrimaryAttempts}회 실패 — 최후 수단으로 ${fallback} 폴백`) +
        `: ${safeFailureDetail(failure)}`,
    );
    const fallbackOpts: CompleteOpts = {
      ...baseOpts,
      model: fallback,
      ...(policy.fallbackMaxTokens !== undefined ? { maxTokens: policy.fallbackMaxTokens } : {}),
      ...(policy.fallbackThinking ? { thinking: policy.fallbackThinking } : {}),
    };
    try {
      const text = await invoke(fallbackOpts);
      noteSuccess(trace, policy.stage, fallback, true);
      return text;
    } catch (fallbackErr) {
      noteFailure(trace, policy.stage, "fallback", fallbackOpts, fallbackErr);
      step.failures++;
      syncTotals(trace);
      throw fallbackErr;
    }
  };

  step.attempts++;
  try {
    const text = await invoke(initial);
    noteSuccess(trace, policy.stage, primary, false);
    return text;
  } catch (firstErr) {
    noteFailure(trace, policy.stage, "initial", initial, firstErr);
    if (policy.retryPrimary === false) {
      return invokeFallback(firstErr, initial, 1);
    }
    const retryTokens = starved(firstErr)
      ? Math.max(opts.maxTokens ?? 1024, policy.retryMaxTokens ?? (opts.maxTokens ?? 1024) * 2)
      : opts.maxTokens;
    const retry = { ...initial, ...(retryTokens ? { maxTokens: retryTokens } : {}) };
    step.retries++;
    step.attempts++;
    console.warn(
      `[digest:${trace.runId}] ${policy.stage} ${primary} 실패 — 같은 모델로 1회 재시도` +
        (retryTokens !== opts.maxTokens ? ` (출력 토큰 ${opts.maxTokens ?? 1024}→${retryTokens})` : "") +
        `: ${safeFailureDetail(firstErr)}`,
    );
    try {
      const text = await invoke(retry);
      noteSuccess(trace, policy.stage, primary, false);
      return text;
    } catch (secondErr) {
      noteFailure(trace, policy.stage, "retry", retry, secondErr);
      return invokeFallback(secondErr, retry, 2);
    }
  }
}
