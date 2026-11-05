import type { ProviderErrorCategory } from "./providerError.js";
/** Metadata only: never store prompts, response text, reasoning text, keys or full URLs. */
export interface LlmCallDiagnostics {
  version: 1;
  requestId: string;
  startedAt: string;
  durationMs: number;
  stage: "preparing" | "awaiting_headers" | "reading_body" | "parsing_response" | "validating_response" | "complete";
  endpointHost?: string;
  nodeVersion: string;
  stream: boolean;
  appTimeoutMs: null;
  systemChars: number;
  userChars: number;
  requestBytes: number;
  receivedBytes: number;
  receivedChunks: number;
  headersMs?: number;
  firstByteMs?: number;
  lastByteMs?: number;
  /** First model output, distinct from transport keep-alive bytes. */
  firstReasoningMs?: number;
  firstContentMs?: number;
  /** SSE terminal marker received; a successful finish reason is checked separately. */
  streamCompleted?: boolean;
  idleMs?: number;
  httpStatus?: number;
  providerRequestId?: string;
  errorName?: string;
  errorCodes?: string[];
  errorCategory?: ProviderErrorCategory;
  errorParam?: string | null;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  reasoningTokens?: number;
  effectiveModel?: string;
  effectiveThinking?: "enabled" | "disabled" | "unknown";
  reasoningChars?: number;
  contentChars?: number;
  effectiveMaxTokens?: number;
}
