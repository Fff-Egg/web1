import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";

export interface ChatCompletionStreamResult {
  content: string;
  reasoningChars: number;
  finishReason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read one completion without retaining reasoning text or returning partial output. */
export async function readChatCompletionStream(
  chunks: AsyncIterable<string>,
  diagnostics: LlmCallDiagnostics,
  elapsed: () => number,
): Promise<ChatCompletionStreamResult> {
  const content: string[] = [];
  let contentChars = 0;
  let reasoningChars = 0;
  let finishReason: string | undefined;
  let usage: ChatCompletionStreamResult["usage"];
  let line = "";
  let skipLf = false;
  let eventType = "";
  let dataLines: string[] = [];
  diagnostics.streamCompleted = false;
  diagnostics.stage = "reading_body";

  // Error text is fixed: JSON parser errors and provider events can echo input.
  const invalid = (detail: string): Error => {
    diagnostics.stage = "parsing_response";
    return new Error(`LLM invalid SSE response: ${detail}`);
  };
  const updateUsage = (value: unknown): void => {
    if (value === undefined || value === null) return;
    if (!isRecord(value)) throw invalid("invalid usage");
    for (const key of ["prompt_tokens", "completion_tokens"] as const) {
      const tokens = value[key];
      if (tokens === undefined) continue;
      if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
        throw invalid("invalid usage");
      }
      usage ??= {};
      usage[key] = tokens;
      if (key === "prompt_tokens") diagnostics.promptTokens = tokens;
      else diagnostics.completionTokens = tokens;
    }
  };
  const dispatch = (): boolean => {
    const type = eventType;
    eventType = "";
    if (dataLines.length === 0) return false;
    const data = dataLines.join("\n");
    dataLines = [];
    if (type === "error") throw invalid("provider stream error");
    if (data === "[DONE]") {
      diagnostics.streamCompleted = true;
      if (!finishReason) throw invalid("missing finish reason");
      return true;
    }
    diagnostics.stage = "parsing_response";
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw invalid("malformed event JSON"); }
    if (!isRecord(parsed)) throw invalid("invalid completion event");
    if (parsed.error !== undefined) throw invalid("provider stream error");
    if (!Array.isArray(parsed.choices)) throw invalid("missing completion choices");
    updateUsage(parsed.usage);
    // Only the first choice is requested. Accept usage-only chunks as well, so
    // an OpenAI-compatible gateway may send usage separately from its last delta.
    const choice = parsed.choices.find((candidate: unknown) =>
      isRecord(candidate) && candidate.index === 0,
    ) ?? parsed.choices[0];
    if (choice !== undefined) {
      if (!isRecord(choice)) throw invalid("invalid completion choice");
      if (choice.index !== undefined && choice.index !== 0) throw invalid("missing first choice");
      const delta = choice.delta;
      if (delta !== undefined && !isRecord(delta)) throw invalid("invalid completion delta");
      if (isRecord(delta)) {
        const reasoning = delta.reasoning_content;
        const text = delta.content;
        if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
          throw invalid("invalid reasoning delta");
        }
        if (text !== undefined && text !== null && typeof text !== "string") {
          throw invalid("invalid content delta");
        }
        if (typeof reasoning === "string" && reasoning.length > 0) {
          diagnostics.firstReasoningMs ??= elapsed();
          reasoningChars += reasoning.length;
          diagnostics.reasoningChars = reasoningChars;
        }
        if (typeof text === "string" && text.length > 0) {
          diagnostics.firstContentMs ??= elapsed();
          content.push(text);
          contentChars += text.length;
          diagnostics.contentChars = contentChars;
        }
      }
      const reason = choice.finish_reason;
      if (reason !== undefined && reason !== null) {
        if (typeof reason !== "string" || !/^[a-z_]{1,40}$/.test(reason)) {
          throw invalid("invalid finish reason");
        }
        if (finishReason && finishReason !== reason) throw invalid("conflicting finish reasons");
        finishReason = reason;
        diagnostics.finishReason = reason;
      }
    }
    diagnostics.stage = "reading_body";
    return false;
  };
  const acceptLine = (value: string): boolean => {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return false;
    const colon = value.indexOf(":");
    const field = colon === -1 ? value : value.slice(0, colon);
    let valuePart = colon === -1 ? "" : value.slice(colon + 1);
    if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
    if (field === "data") dataLines.push(valuePart);
    else if (field === "event") eventType = valuePart;
    return false;
  };

  // CR, LF, and CRLF are all SSE line endings. A CR at the end of one transport
  // chunk already ends the line; skip a following LF even in the next chunk.
  for await (const chunk of chunks) {
    if (chunk.length === 0) continue;
    let start = skipLf && chunk[0] === "\n" ? 1 : 0;
    skipLf = false;
    for (let cursor = start; cursor < chunk.length; cursor++) {
      const character = chunk[cursor];
      if (character !== "\r" && character !== "\n") continue;
      line += chunk.slice(start, cursor);
      if (acceptLine(line)) {
        // Returning from for-await closes the source generator and its reader.
        return { content: content.join(""), reasoningChars, finishReason: finishReason!, ...(usage ? { usage } : {}) };
      }
      line = "";
      if (character === "\r") {
        if (chunk[cursor + 1] === "\n") cursor++;
        else if (cursor === chunk.length - 1) skipLf = true;
      }
      start = cursor + 1;
    }
    line += chunk.slice(start);
  }
  // SSE dispatches on a blank line, not on EOF. Even a complete-looking final
  // JSON object cannot make an interrupted connection a successful completion.
  diagnostics.stage = "reading_body";
  throw new Error("LLM stream terminated before [DONE] — 부분 결과는 저장하지 않습니다.");
}
