import type { LlmUsageBucket } from "./llmUsage.js";
import type { ProviderErrorCategory } from "./providerError.js";

// Official Flash rates checked 2026-09-21. Reference estimates, not billing-time prices.
export const FLASH_OFFPEAK_RATES = { hit: 0.003, miss: 0.15, output: 0.6 } as const;
export function discountedFlashEstimate(row: Pick<LlmUsageBucket, "model" | "endpointHost" | "costBasis">): { usd: number; requests: number } | null {
  if (row.endpointHost !== "api.deepseek.com" || !["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(row.model)) return null;
  const b = row.costBasis;
  if (!b || b.requests <= 0 || ![b.cacheHitTokens, b.cacheMissTokens, b.outputTokens].every(n => Number.isFinite(n) && n >= 0)) return null;
  return { usd: (b.cacheHitTokens * FLASH_OFFPEAK_RATES.hit + b.cacheMissTokens * FLASH_OFFPEAK_RATES.miss + b.outputTokens * FLASH_OFFPEAK_RATES.output) / 1_000_000, requests: b.requests };
}

export function usageKstDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

const PROVIDER_FAILURE_LABELS: Record<ProviderErrorCategory, string> = {
  context_limit: "입력·출력 합산 한도 초과", max_tokens: "출력 한도 설정 거절", model: "모델 설정 거절",
  unsupported_parameter: "지원하지 않는 요청 설정", stream_options: "스트리밍 설정 충돌",
  json_requirement: "JSON 출력 조건 미충족", invalid_unicode: "문자 인코딩 오류", invalid_json: "요청 JSON 형식 오류",
  content_policy: "제공자의 내용 정책 거절", authentication: "API 인증·권한 오류", balance: "API 잔액 부족",
  rate_limit: "API 호출 한도 초과", unknown: "요청 오류",
};
export function usageFailureLabel(row: { httpStatus: number | null; finishReason: string | null; errorCategory?: ProviderErrorCategory | null; errorParam?: string | null }): string {
  if (row.httpStatus !== null && row.httpStatus >= 400) return `${PROVIDER_FAILURE_LABELS[row.errorCategory ?? "unknown"]} (HTTP ${row.httpStatus})${row.errorParam ? ` · ${row.errorParam}` : ""}`;
  if (row.finishReason === "length" || row.finishReason === "max_tokens") return "출력 한도 초과 (응답 잘림)";
  return "응답 처리 실패 (상세 미확인)";
}

export const LLM_STAGE_LABELS: Record<string, string> = {
  filter: "글 선별", whole_reading: "전체 본문 구간 요약", digest_map: "보고서 자료 정리",
  digest_final: "최종 보고서", digest_fallback: "실패 후 대체 작성", feedback: "학습 메모",
  deep_analysis: "개별 심층 분석", research_summary: "증권사 리포트 요약", unknown: "기타",
};
