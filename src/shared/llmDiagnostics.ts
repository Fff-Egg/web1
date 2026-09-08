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
  idleMs?: number;
  httpStatus?: number;
  providerRequestId?: string;
  errorName?: string;
  errorCodes?: string[];
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningChars?: number;
  contentChars?: number;
  effectiveMaxTokens?: number;
}
