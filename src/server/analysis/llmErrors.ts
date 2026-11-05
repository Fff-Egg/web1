/** Typed control flow for a provider response that consumed its output budget. */
export class LlmOutputLimitError extends Error {
  readonly code = "LLM_OUTPUT_LIMIT";
  readonly finishReason = "length";
  constructor(message: string) { super(message); this.name = "LlmOutputLimitError"; }
}
export function isLlmOutputLimitError(error: unknown): error is LlmOutputLimitError {
  return error instanceof LlmOutputLimitError || (error !== null && typeof error === "object" &&
    "code" in error && error.code === "LLM_OUTPUT_LIMIT");
}

export class WholeReadingHeldError extends Error {
  readonly code = "WHOLE_READING_HELD";
  constructor() {
    super("전체 읽기가 반복 실패하여 자동 재시도를 보류했습니다. 본문과 완료된 구간은 보존했습니다. 설정을 확인한 뒤 명시적으로 다시 시도해 주세요.");
    this.name = "WholeReadingHeldError";
  }
}
