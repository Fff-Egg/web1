import type { LlmUsageBucket } from "./llmUsage.js";

// Official Flash rates checked 2026-09-21. Reference estimates, not billing-time prices.
export const FLASH_OFFPEAK_RATES = { hit: 0.003, miss: 0.15, output: 0.6 } as const;
export function discountedFlashEstimate(row: LlmUsageBucket): { usd: number; requests: number } | null {
  if (row.endpointHost !== "api.deepseek.com" || !["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(row.model)) return null;
  const b = row.costBasis;
  if (!b || b.requests <= 0 || ![b.cacheHitTokens, b.cacheMissTokens, b.outputTokens].every(n => Number.isFinite(n) && n >= 0)) return null;
  return { usd: (b.cacheHitTokens * FLASH_OFFPEAK_RATES.hit + b.cacheMissTokens * FLASH_OFFPEAK_RATES.miss + b.outputTokens * FLASH_OFFPEAK_RATES.output) / 1_000_000, requests: b.requests };
}

export const LLM_STAGE_LABELS: Record<string, string> = {
  filter: "글 선별", whole_reading: "전체 본문 구간 요약", digest_map: "보고서 자료 정리",
  digest_final: "최종 보고서", digest_fallback: "실패 후 대체 작성", feedback: "학습 메모",
  deep_analysis: "개별 심층 분석", research_summary: "증권사 리포트 요약", unknown: "기타",
};
