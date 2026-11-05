import type { ArticleContentMeta, ReadingCache } from "./articleContent.js";
import type { LlmUsageEvent } from "./llmUsage.js";

export interface ArticleReadingDiagnostics {
  completedAt: string | null;
  inputChars: number;
  chunkCount: number;
  savedChunkCount: number;
  savedChunkChars: number;
  samples: { ordinal: number; chars: number; text: string; truncated: boolean }[];
  recovery: null | {
    policy: number | null; inputCharLimit: number | null; calls: number; splitCount: number; proactiveSplitCount: number;
    held: { reason: string; at: string } | null;
  };
}
export type ArticleUsageAttempt = Pick<LlmUsageEvent, "startedAt" | "stage" | "model" | "thinking" | "success" | "durationMs" |
  "httpStatus" | "finishReason" | "errorCategory" | "errorParam" | "inputTokens" | "outputTokens">;
export interface ArticleAnalysisDiagnostics {
  id: number; title: string | null; url: string | null; provider: string | null;
  body: string; bodyChars: number; sourceBodyChars: number | null;
  content: {
    scope: string; status: ArticleContentMeta["status"] | null; method: ArticleContentMeta["method"] | null;
    checkedAt: string | null; pending: boolean; extractedLinks: number; unavailableLinks: number; skippedLinks: number;
  };
  analysis: { completed: boolean; analyzedAt: string | null };
  sourceReading: { completed: boolean; chars: number | null; bytes: number | null } | null;
  reading: ArticleReadingDiagnostics | null;
  attempts: ArticleUsageAttempt[];
}
export interface ArticleAnalysisDiagnosticsResponse { persisted: boolean; article: ArticleAnalysisDiagnostics | null }

/** Bounded previews of successful stored outputs, not failed partial responses. */
export function readingDiagnostics(cache?: ReadingCache | null): ArticleReadingDiagnostics | null {
  if (!cache) return null;
  const chunks = Object.entries(cache.chunks).filter(([, text]) => typeof text === "string" && text.trim())
    .sort(([a], [b]) => a.localeCompare(b));
  const indexes = chunks.length ? [...new Set([0, Math.floor(chunks.length / 2), chunks.length - 1])] : [];
  const samples = indexes.map(index => {
    const text = chunks[index][1];
    let end = Math.min(text.length, 3000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return { ordinal: index + 1, chars: text.length, text: text.slice(0, end), truncated: end < text.length };
  });
  const r = cache.recovery;
  return {
    completedAt: cache.completedAt ?? null, inputChars: cache.inputChars, chunkCount: cache.chunkCount,
    savedChunkCount: chunks.length, savedChunkChars: chunks.reduce((sum, [, text]) => sum + text.length, 0), samples,
    recovery: r ? { policy: r.policy ?? null, inputCharLimit: r.inputCharLimit ?? null, calls: r.calls,
      splitCount: Object.keys(r.splits).length, proactiveSplitCount: Object.keys(r.proactiveSplits ?? {}).length,
      held: r.held ? { reason: r.held.reason, at: r.held.at } : null } : null,
  };
}
