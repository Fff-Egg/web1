import {
  complete,
  resolveModel,
  type CompleteOpts,
} from "../analysis/anthropic.js";

export type DigestModelStage = "map" | "final";

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
}

/** Stored in digests.meta.models. Top-level legacy fields remain for old UI/code. */
export interface ModelTrace {
  version: 2;
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

function newStage(configured: string): StageModelTrace {
  return {
    configured,
    planned: resolveModel(configured),
    used: [],
    attempts: 0,
    retries: 0,
    fallbacks: 0,
    failures: 0,
  };
}

export function newModelTrace(mapModel: string, finalModel: string): ModelTrace {
  const map = newStage(mapModel);
  const final = newStage(finalModel);
  return {
    version: 2,
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

function starved(err: unknown): boolean {
  return /finish_reason=length/.test(message(err));
}

export type CompleteFn = (opts: CompleteOpts) => Promise<string>;

export interface DigestCallPolicy {
  stage: DigestModelStage;
  /** Emergency model used only after the planned model has failed twice. */
  fallbackModel?: string;
  /** Token budget for a same-model retry after finish_reason=length. */
  retryMaxTokens?: number;
}

/**
 * Digest call policy:
 *   1. planned model
 *   2. the SAME model once more (larger budget when it ran out of tokens)
 *   3. only then the emergency fallback, if configured
 *
 * Map calls normally omit fallbackModel, so Flash retries as Flash and a broken
 * chunk is surfaced. Final calls pass Flash as fallback, preserving Pro as the
 * writer whenever either Pro attempt succeeds.
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
  step.attempts++;
  try {
    const text = await invoke(initial);
    noteSuccess(trace, policy.stage, primary, false);
    return text;
  } catch (firstErr) {
    const retryTokens = starved(firstErr)
      ? Math.max(opts.maxTokens ?? 1024, policy.retryMaxTokens ?? (opts.maxTokens ?? 1024) * 2)
      : opts.maxTokens;
    const retry = { ...initial, ...(retryTokens ? { maxTokens: retryTokens } : {}) };
    step.retries++;
    step.attempts++;
    console.warn(
      `[digest] ${policy.stage} ${primary} 실패 — 같은 모델로 1회 재시도` +
        (retryTokens !== opts.maxTokens ? ` (출력 토큰 ${opts.maxTokens ?? 1024}→${retryTokens})` : "") +
        `: ${message(firstErr)}`,
    );
    try {
      const text = await invoke(retry);
      noteSuccess(trace, policy.stage, primary, false);
      return text;
    } catch (secondErr) {
      const fallback = policy.fallbackModel ? resolveModel(policy.fallbackModel) : "";
      if (fallback && fallback !== primary) {
        step.attempts++;
        console.warn(
          `[digest] ${policy.stage} ${primary} 2회 실패 — 최후 수단으로 ${fallback} 폴백: ${message(secondErr)}`,
        );
        try {
          const text = await invoke({ ...retry, model: fallback });
          noteSuccess(trace, policy.stage, fallback, true);
          return text;
        } catch (fallbackErr) {
          step.failures++;
          syncTotals(trace);
          throw fallbackErr;
        }
      }
      step.failures++;
      syncTotals(trace);
      throw secondErr;
    }
  }
}
