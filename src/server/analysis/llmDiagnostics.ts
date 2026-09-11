import { randomUUID } from "node:crypto";
import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";

/** Deliberately reject arbitrary messages/header text: diagnostics must not echo content. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
}

export class LlmCallProbe {
  private readonly start = performance.now();
  readonly data: LlmCallDiagnostics;
  constructor(system: string, user: string) {
    this.data = {
      version: 1, requestId: randomUUID(), startedAt: new Date().toISOString(),
      durationMs: 0, stage: "preparing", nodeVersion: process.version,
      stream: false, appTimeoutMs: null, systemChars: system.length, userChars: user.length,
      requestBytes: 0, receivedBytes: 0, receivedChunks: 0,
    };
  }
  elapsed(): number { return Math.max(0, Math.round(performance.now() - this.start)); }
  request(base: string, body: string): void {
    this.data.endpointHost = new URL(base).hostname;
    this.data.requestBytes = Buffer.byteLength(body);
    const parsed = JSON.parse(body);
    this.data.stream = parsed.stream === true;
    if (typeof parsed.max_tokens === "number") this.data.effectiveMaxTokens = parsed.max_tokens;
    this.data.stage = "awaiting_headers";
  }
  async *chunks(res: Response): AsyncGenerator<string> {
    this.data.httpStatus = res.status;
    this.data.headersMs = this.elapsed();
    this.data.providerRequestId = identifier(res.headers.get("x-request-id")) ?? identifier(res.headers.get("request-id"));
    this.data.stage = "reading_body";
    if (!res.body) return;
    // Count transport bytes for both JSON and SSE, including keep-alives.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        if (value.byteLength === 0) continue;
        const now = this.elapsed();
        this.data.firstByteMs ??= now;
        this.data.lastByteMs = now;
        this.data.receivedBytes += value.byteLength;
        this.data.receivedChunks++;
        yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      // A parser may stop at [DONE] or reject an event before the socket closes.
      // Release that response without replacing its original success/failure.
      if (!finished) { try { await reader.cancel(); } catch { /* already failed */ } }
      reader.releaseLock();
    }
  }
  async read(res: Response): Promise<string> {
    const parts: string[] = [];
    for await (const chunk of this.chunks(res)) parts.push(chunk);
    return parts.join("");
  }
  failure(error: unknown): void {
    const codes: string[] = [];
    let current = error;
    const seen = new Set<unknown>();
    for (let depth = 0; current && typeof current === "object" && depth < 5 && !seen.has(current); depth++) {
      seen.add(current);
      const e = current as { name?: unknown; code?: unknown; cause?: unknown };
      if (depth === 0) this.data.errorName = identifier(e.name);
      const code = identifier(e.code);
      if (code && !codes.includes(code)) codes.push(code);
      current = e.cause;
    }
    if (codes.length) this.data.errorCodes = codes;
  }
  publish(callback?: (d: LlmCallDiagnostics) => void): void {
    this.data.durationMs = this.elapsed();
    if (this.data.stage === "reading_body") {
      this.data.idleMs = this.data.durationMs - (this.data.lastByteMs ?? this.data.headersMs ?? 0);
    }
    // An observer must never cause a paid retry or change a successful result.
    try { callback?.({ ...this.data }); } catch { /* observation only */ }
  }
}
