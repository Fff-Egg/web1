import Anthropic from "@anthropic-ai/sdk";
import { LlmCallProbe } from "./llmDiagnostics.js";
import { readChatCompletionStream } from "./chatCompletionStream.js";
import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";
import { supportsDeepSeekThinking } from "../../shared/deepseekModels.js";
import type { LlmUsageContext, LlmUsageEvent } from "../../shared/llmUsage.js";
import { currentLlmUsageContext, observeLlmUsage } from "./usageObservation.js";
import { recordProviderUsage, tokenCount } from "./providerUsage.js";
import { LlmOutputLimitError, LlmRefusalError } from "./llmErrors.js";
import { diagnoseProviderError, LlmProviderError } from "./providerError.js";
import { hasLLM, llmProvider, usingOpenAI } from "./provider.js";
import {
  CLAUDE_BULK_MODEL,
  CLAUDE_FINAL_MODEL,
  CLAUDE_LOW_EFFORT_HEADROOM,
  CLAUDE_TOKENIZER_ALLOWANCE,
  claudeThinkingRequest,
  isClaudeModel,
  isLegacyClaudeModel,
  parseClaudeEffort,
  supportsServerFallback,
} from "./claudeModels.js";

export { hasLLM, llmProvider, type LlmProvider } from "./provider.js";

let _client: Anthropic | null = null;

/** @deprecated kept for back-compat; prefer hasLLM(). */
export function hasAnthropic(): boolean {
  return hasLLM();
}

export function getAnthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// Model defaults depend on the active provider. With an OpenAI-compatible
// endpoint, set LLM_MODEL (or FILTER_MODEL / ANALYSIS_MODEL) to that host's id
// (e.g. "llama-3.3-70b-versatile", "qwen-2.5-32b").
const OPENAI_DEFAULT_MODEL = () => process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Return the model id that will actually be sent to the active provider.
 *
 * Old Settings/Railway values may still contain a `claude-*` id after the app
 * was moved to an OpenAI-compatible endpoint. `complete()` has always replaced
 * that stale id with LLM_MODEL, but callers used to log the pre-replacement id.
 * Keeping resolution public and pure-at-call-time lets the digest trace show the
 * real model (for example deepseek-v4-flash rather than Claude Haiku).
 *
 * The reverse happens after a move to the Claude API: Settings/Railway can still hold
 * DeepSeek ids (deepseek-flash …) that 404 there. They map by tier — Pro/Reasoner-class
 * ids to the final-stage default, everything else to the bulk default — so each stage
 * keeps its cheap/expensive role until a Claude model is chosen in Settings.
 */
export function resolveModel(model: string): string {
  const id = model.trim();
  if (usingOpenAI()) return id.startsWith("claude") ? OPENAI_DEFAULT_MODEL() : id;
  if (llmProvider() !== "anthropic" || !id || isClaudeModel(id)) return id;
  return /(?:^|[-_.])(?:pro|reasoner)(?:$|[-_.])/i.test(id) ? CLAUDE_FINAL_MODEL : CLAUDE_BULK_MODEL;
}

/** Protocol support follows the provider endpoint, so model upgrades need no code change. */
export function supportsThinkingControl(model: string): boolean {
  const resolved = resolveModel(model);
  if (usingOpenAI()) return supportsDeepSeekThinking(process.env.LLM_BASE_URL, resolved);
  return llmProvider() === "anthropic" && isClaudeModel(resolved) && !isLegacyClaudeModel(resolved);
}

export const FILTER_MODEL = () =>
  resolveModel(process.env.FILTER_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : CLAUDE_BULK_MODEL));
export const ANALYSIS_MODEL = () =>
  resolveModel(process.env.ANALYSIS_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : CLAUDE_FINAL_MODEL));


/**
 * 짝 없는(lone) 서로게이트 제거 — **LLM 호출 직전 최종 방어**.
 *
 * 이모지·일부 한자는 UTF-16에서 2칸(서로게이트 페어)을 차지한다. 프롬프트를 만들 때
 * `slice(0, n)`이 그 한가운데를 자르면 반쪽만 남고, `JSON.stringify`는 그것을
 * `\ud83d` 같은 형태로 그대로 내보낸다. Node의 파서는 이를 허용하지만 **서버 쪽
 * 엄격한 파서(Rust serde_json 등)는 거부**한다 — high 서로게이트 뒤에 `\u`가
 * 안 오면 정확히 `unexpected end of hex escape` 400이 난다(2026-08 실제 장애).
 *
 * 우리 코드의 절단부는 개별로 고쳤지만, 소스 피드가 애초에 깨진 문자를 줄 수도 있어
 * **모든 LLM 요청이 반드시 지나는 이 지점**에서 한 번 더 거른다. 정상 페어는 보존된다.
 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}


/**
 * 제공자별 추가 요청 파라미터(JSON) — `LLM_EXTRA_BODY` env로 주입한다.
 *
 * 왜 필요한가: **추론형(thinking) 모델은 `max_tokens` 예산을 사고 과정에 먼저 쓴다.**
 * 예산이 모자라면 사고만 하다 잘려서 `content`가 빈 채로 200이 온다(2026-08 실장애:
 * deepseek-v4-pro가 요청당 출력 ~7,000토큰을 쓰고도 다이제스트 내용은 빈 문자열).
 * 일반 OpenAI 호환 제공자의 전용 파라미터는 이름이 제각각이므로 이 env로
 * 넘긴다. 다만 현재 주 제공자인 DeepSeek V4는 thinking이 기본 ON이라는
 * 공식 규격이 확정돼 있어, 기사마다 수천 개의 사고 토큰을 쓰지 않도록 앱이
 * 비추론 모드를 안전 기본값으로 넣는다. 다이제스트 파이프라인은 이 전역값과
 * 별개로 호출별 `thinking`을 넘긴다. 기본은 **최종 종합 ON**, 필터·맵은 OFF며,
 * Settings에서 단계별로 바꿀 수 있다. `LLM_EXTRA_BODY`는 그 밖의 호출에 적용할 전역 기본값이다.
 * 파싱 실패는 무시하고 경고만 남긴다 — 잘못된 env가 분석 전체를 막으면 안 된다.
 */
function extraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    console.warn("[llm] LLM_EXTRA_BODY는 JSON 객체여야 합니다 — 무시합니다.");
  } catch (e) {
    console.warn(`[llm] LLM_EXTRA_BODY 파싱 실패 — 무시합니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {};
}

export interface CompleteOpts {
  /** Attribution only; never sent to the provider. */
  usage?: LlmUsageContext;
  /** Observation only; never changes model parameters or retries. */
  onDiagnostics?: (diagnostics: LlmCallDiagnostics) => void;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** Explicit JSON output for compatible endpoints; Anthropic ignores this option. */
  responseFormat?: "json_object";
  /** Per-call thinking switch (DeepSeek V4 · current Claude models). Ignored where unsupported. */
  thinking?: "enabled" | "disabled";
}

/** Single-turn helper: system prompt + user content -> assistant text. */
export async function complete(opts: CompleteOpts): Promise<string> {
  // Saved Settings may still carry the other provider's model ids (Claude ids on an
  // OpenAI-compatible host, DeepSeek ids on the Claude API); both would 404.
  const model = resolveModel(opts.model);
  return usingOpenAI() ? completeOpenAI({ ...opts, model }) : completeAnthropic({ ...opts, model });
}

const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Set once the API rejects the fallback opt-in, so later calls skip it instead of failing. */
let serverFallbackRejected = false;

/** Status for an SSE error event that arrives after a 200 header. */
function streamErrorStatus(body: unknown): number {
  const type = (body as { error?: { type?: unknown } } | undefined)?.error?.type;
  return type === "overloaded_error" ? 529 : type === "rate_limit_error" ? 429 : type === "invalid_request_error" ? 400 : 500;
}

function isFallbackRejection(error: unknown): boolean {
  return error instanceof Anthropic.APIError && error.status === 400 && /anthropic-beta|fallbacks/i.test(error.message);
}

/**
 * Claude API — the same guard rails as the OpenAI-compatible path (2026-08 incident C):
 *  - Always streamed; only the finished message is returned. A Thinking-ON final call
 *    (max_tokens ≥ 49,152) is refused outright by the SDK without streaming.
 *  - stop_reason=max_tokens throws LlmOutputLimitError: a cut-off answer is never saved.
 *  - A refusal or an empty answer throws; HTTP errors become LlmProviderError so the
 *    existing retry/pause policy applies (e.g. credit balance exhausted → 60 min pause).
 *  - The system prompt carries cache_control: the per-article filter resends the same
 *    instructions back to back, and cache reads cost a tenth of normal input.
 */
async function completeAnthropic(opts: CompleteOpts): Promise<string> {
  const probe = new LlmCallProbe(opts.system, opts.user);
  const plan = claudeThinkingRequest(opts.model, opts.thinking, parseClaudeEffort(process.env.CLAUDE_THINKING_EFFORT));
  const requested = opts.maxTokens ?? 1024;
  const scaled = opts.thinking === "enabled" ? requested : Math.ceil(requested * CLAUDE_TOKENIZER_ALLOWANCE);
  const maxTokens = plan.needsHeadroom ? scaled + CLAUDE_LOW_EFFORT_HEADROOM : scaled;
  const request = {
    model: opts.model,
    max_tokens: maxTokens,
    system: [{ type: "text" as const, text: stripLoneSurrogates(opts.system), cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: stripLoneSurrogates(opts.user) }],
    ...(plan.thinking ? { thinking: plan.thinking } : {}),
    ...(plan.effort ? { output_config: { effort: plan.effort } } : {}),
  };
  const params: Anthropic.MessageStreamParams = request;
  probe.data.endpointHost = "api.anthropic.com";
  probe.data.effectiveModel = opts.model;
  probe.data.effectiveThinking = plan.effectiveThinking;
  probe.data.effectiveMaxTokens = maxTokens;
  probe.data.requestBytes = Buffer.byteLength(JSON.stringify(params));
  probe.data.stream = true;
  probe.data.stage = "awaiting_headers";
  let success = false;
  const onConnect = () => {
    probe.data.httpStatus = 200;
    probe.data.headersMs = probe.elapsed();
    probe.data.stage = "reading_body";
  };
  const onEvent = () => { probe.data.firstByteMs ??= probe.elapsed(); probe.data.receivedChunks++; };
  const onText = () => { probe.data.firstContentMs ??= probe.elapsed(); };
  const requestId = (value: string | null | undefined) =>
    typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : undefined;
  const run = async (withFallback: boolean) => {
    if (withFallback) {
      const stream = getAnthropic().beta.messages.stream({ ...request, betas: [SERVER_FALLBACK_BETA], fallbacks: "default" });
      stream.once("connect", onConnect).on("streamEvent", onEvent).once("text", onText);
      const message = await stream.finalMessage();
      probe.data.providerRequestId = requestId(stream.request_id);
      return message;
    }
    const stream = getAnthropic().messages.stream(params);
    stream.once("connect", onConnect).on("streamEvent", onEvent).once("text", onText);
    const message = await stream.finalMessage();
    probe.data.providerRequestId = requestId(stream.request_id);
    return message;
  };
  try {
    let res;
    try {
      res = await run(supportsServerFallback(opts.model) && !serverFallbackRejected);
    } catch (error) {
      // A 400 for the beta opt-in itself is rejected before generation (no charge):
      // remember it and send the same request once without the opt-in.
      if (!isFallbackRejection(error)) throw error;
      serverFallbackRejected = true;
      console.warn(`[llm] Claude 서버 측 폴백(beta) 미지원 — 이후 호출은 폴백 없이 보냅니다 (model=${opts.model}).`);
      res = await run(false);
    }
    probe.data.stage = "validating_response";
    probe.data.lastByteMs = probe.elapsed();
    probe.data.streamCompleted = true;
    // input_tokens excludes cache reads and writes. Uncached input = plain input + cache
    // writes (the 1.25x write premium is left out of cost estimates).
    const usage = res.usage;
    const hit = tokenCount(usage.cache_read_input_tokens) ?? 0;
    const creation = tokenCount(usage.cache_creation_input_tokens) ?? 0;
    const input = tokenCount(usage.input_tokens);
    if (input !== undefined) {
      probe.data.promptTokens = input + hit + creation;
      probe.data.cacheHitTokens = hit;
      probe.data.cacheMissTokens = input + creation;
    }
    probe.data.completionTokens = tokenCount(usage.output_tokens);
    if (typeof res.model === "string" && /^[\w./:-]{1,160}$/.test(res.model)) probe.data.effectiveModel = res.model;
    const reason = res.stop_reason ?? "unknown";
    probe.data.finishReason = /^[a-z_]{1,40}$/.test(reason) ? reason : "unknown";
    const blocks: ReadonlyArray<{ type: string; text?: string }> = res.content;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
    probe.data.contentChars = text.length;
    const iterations = (usage as { iterations?: ReadonlyArray<{ type?: string }> | null }).iterations ?? [];
    if (blocks.some((b) => b.type === "fallback") || iterations.some((i) => i.type === "fallback_message")) {
      console.warn(`[llm] ${opts.model} 거절 → 서버 측 폴백 ${res.model}이(가) 응답했습니다.`);
    }
    const detail = `finish_reason=${reason === "max_tokens" ? "length" : reason} stop_reason=${reason}` +
      ` tokens(prompt=${probe.data.promptTokens ?? "?"}, completion=${probe.data.completionTokens ?? "?"}) max_tokens=${maxTokens}`;
    if (reason === "max_tokens") {
      console.warn(`[llm] 불완전 응답 폐기 (model=${opts.model}) ${detail}${text ? ` partial_chars=${text.length}` : ""}`);
      throw new LlmOutputLimitError(
        `LLM 응답 잘림 (${detail}${text ? ` partial_chars=${text.length}` : ""}) — 부분 결과는 저장하지 않습니다.`,
      );
    }
    if (reason === "refusal") {
      const category = (res.stop_details as { category?: unknown } | null | undefined)?.category;
      probe.data.errorCategory = "content_policy";
      throw new LlmRefusalError(
        `LLM 응답 거절 (content_filter; stop_reason=refusal category=${typeof category === "string" && /^[a-z_]{1,40}$/.test(category) ? category : "none"})`,
      );
    }
    if (!text) {
      console.error(`[llm] 빈 응답 (model=${opts.model}) ${detail}`);
      throw new Error(`LLM 빈 응답 (${detail})`);
    }
    probe.data.stage = "complete";
    success = true;
    return text;
  } catch (error) {
    probe.failure(error);
    if (error instanceof Anthropic.APIError && !(error instanceof Anthropic.APIConnectionError)) {
      // Keep only a finite category and an allowlisted parameter, never the body text.
      const status = typeof error.status === "number" ? error.status : streamErrorStatus(error.error);
      const diagnosis = diagnoseProviderError(JSON.stringify(error.error ?? {}), status);
      probe.data.httpStatus = status;
      probe.data.errorCategory = diagnosis.category;
      probe.data.errorParam = diagnosis.param;
      throw new LlmProviderError(status, diagnosis);
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new Error("LLM timeout: Claude API 응답 대기 시간 초과", { cause: error });
    if (error instanceof Anthropic.APIConnectionError) throw new Error("LLM network error: Claude API 연결 실패", { cause: error });
    throw error;
  } finally { probe.publish(opts.onDiagnostics); await recordAttempt(opts, probe.data, success); }
}

/** Whitelisted metadata shape: no prompts, text, secrets or raw error strings. */
async function recordAttempt(opts: CompleteOpts, d: LlmCallDiagnostics, success: boolean): Promise<void> {
  try {
    const identifier = (value: string | undefined, max = 160) => value && value.length <= max && /^[\w./:-]+$/.test(value) ? value : null;
    const context = currentLlmUsageContext();
    const event: LlmUsageEvent = {
      requestId: d.requestId, startedAt: d.startedAt, stage: opts.usage?.stage ?? context.stage ?? "unknown",
      model: identifier(d.effectiveModel) ?? "unknown", endpointHost: identifier(d.endpointHost, 255),
      thinking: d.effectiveThinking ?? "unknown", articleId: tokenCount(opts.usage?.articleId ?? context.articleId) ?? null,
      runId: identifier(opts.usage?.runId ?? context.runId), success, durationMs: Math.min(d.durationMs, 4294967295),
      finishReason: identifier(d.finishReason, 40), httpStatus: d.httpStatus ?? null,
      errorCategory: d.errorCategory ?? null, errorParam: d.errorParam ?? null,
      inputTokens: tokenCount(d.promptTokens) ?? null, cacheHitTokens: tokenCount(d.cacheHitTokens) ?? null,
      cacheMissTokens: tokenCount(d.cacheMissTokens) ?? null, outputTokens: tokenCount(d.completionTokens) ?? null,
      reasoningTokens: tokenCount(d.reasoningTokens) ?? null,
    };
    await observeLlmUsage(event);
  } catch { /* No observer failure may alter a result or initiate a paid retry. */ }
}

/**
 * OpenAI-compatible chat completions (Groq, OpenRouter, DeepInfra, Together,
 * local Ollama, …). Dependency-free — uses the built-in fetch. Configure with:
 *   LLM_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   LLM_API_KEY   the provider's API key
 *   LLM_MODEL     default model id (overridable per-pass via FILTER/ANALYSIS_MODEL)
 */
async function completeOpenAI(opts: CompleteOpts): Promise<string> {
  const probe = new LlmCallProbe(opts.system, opts.user);
  let success = false;
  try {
    const base = process.env.LLM_BASE_URL!.replace(/\/+$/, "");
    const configuredExtra = extraBody();
    const isDeepSeekV4 = supportsThinkingControl(opts.model);
    // DeepSeek V4's API defaults to thinking=enabled. A per-article filter is
    // called hundreds of times a day and does not benefit enough from private
    // chain-of-thought to justify that token bill. Keep non-thinking as the app's
    // cost-safe default for both Flash and Pro. A stage-specific per-call value
    // is applied LAST so final synthesis can think without accidentally enabling it for
    // hundreds of Flash filter/map calls, even when a stale global env exists.
    const costSafeExtra =
      isDeepSeekV4 && configuredExtra.thinking === undefined
        ? { thinking: { type: "disabled" } }
        : {};
    const callExtra =
      isDeepSeekV4 && opts.thinking
        ? { thinking: { type: opts.thinking } }
        : {};
    // Long final thinking calls should deliver generation progress instead
    // of holding the whole answer until the end. This does not add any call or
    // retry. Explicit stage thinking keeps the non-thinking fallback on JSON.
    const streamFinalThinking = isDeepSeekV4 && opts.thinking === "enabled";
    const body = JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0,
        messages: [
          { role: "system", content: stripLoneSurrogates(opts.system) },
          { role: "user", content: stripLoneSurrogates(opts.user) },
        ],
        ...costSafeExtra,
        ...configuredExtra,
        ...callExtra,
        ...(opts.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
        ...(streamFinalThinking ? { stream: true } : {}),
      });
    probe.request(base, body);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body,
    });
    if (!res.ok) {
      const diagnosis = diagnoseProviderError(await probe.read(res), res.status);
      // Provider bodies can echo keys/prompts. Keep only a finite category and
      // exact allowlisted parameter, never the original message/body/code.
      probe.data.errorCategory = diagnosis.category;
      probe.data.errorParam = diagnosis.param;
      throw new LlmProviderError(res.status, diagnosis);
    }
    type Completion = {
      choices?: {
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    let data: Completion;
    let streamedReasoning: number | undefined;
    if (probe.data.stream) {
      const result = await readChatCompletionStream(probe.chunks(res), probe.data, () => probe.elapsed());
      streamedReasoning = result.reasoningChars;
      data = { choices: [{ message: { content: result.content }, finish_reason: result.finishReason }], usage: result.usage };
    } else {
      const raw = await probe.read(res);
      probe.data.stage = "parsing_response";
      try { data = JSON.parse(raw); } catch { throw new Error("LLM invalid JSON response"); }
    }
    probe.data.stage = "validating_response";
    // Billing metadata can be valid even when the generated message is malformed.
    const u = data?.usage;
    recordProviderUsage(probe.data, u);
    const choice = data.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();
    const reason = choice?.finish_reason ?? "?";
    const reasoning = streamedReasoning ?? (choice?.message?.reasoning_content ?? "").length;
    probe.data.finishReason = /^[a-z_]{1,40}$/.test(reason) ? reason : "unknown";
    probe.data.reasoningChars = reasoning;
    probe.data.contentChars = text.length;
    const detail =
      `finish_reason=${reason}` +
      (reasoning > 0 ? ` reasoning_len=${reasoning}` : "") +
      (u ? ` tokens(prompt=${u.prompt_tokens ?? "?"}, completion=${u.completion_tokens ?? "?"})` : "") +
      ` max_tokens=${opts.maxTokens ?? 1024}`;

    // `finish_reason=length` means the answer is incomplete even when content is
    // non-empty. Returning that partial text used to save reports cut off halfway
    // through a sentence (the deterministic bibliography still made them look
    // superficially complete). Throw so the digest policy can record the reason
    // and retry or fall back according to the stage policy.
    if (reason === "length") {
      console.warn(
        `[llm] 불완전 응답 폐기 (model=${opts.model}) ${detail}` +
          (text ? ` partial_chars=${text.length}` : ""),
      );
      throw new LlmOutputLimitError(
        `LLM 응답 잘림 (${detail}${text ? ` partial_chars=${text.length}` : ""})` +
          " — 부분 결과는 저장하지 않습니다.",
      );
    }
    if (probe.data.stream && reason !== "stop") {
      throw new Error(`LLM 불완전 스트림 (finish_reason=${probe.data.finishReason}) — 부분 결과는 저장하지 않습니다.`);
    }
    if (text) { probe.data.stage = "complete"; success = true; return text; }

    // ⚠️ 200인데 본문이 빈 경우 — 예전엔 빈 문자열을 그대로 돌려줘 **조용히 통과**했다.
    // 그러면 다이제스트 맵 단계가 빈 청크를 만들고, 최종 종합은 "입력이 비어 있다"는
    // 쓸모없는 리포트를 저장한다(2026-08 실장애: "### 묶음 1" 제목만 남음).
    // 이제는 던져서 단계 정책이 재시도/폴백하고, 원인이 화면·로그에 드러나게 한다.
    console.error(`[llm] 빈 응답 (model=${opts.model}) ${detail}`);
    const hint =
      reason === "length"
        ? " — 출력 토큰이 부족합니다(추론형 모델이면 사고 토큰이 예산을 다 씁니다). DIGEST_MAP_TOKENS·DIGEST_MAX_TOKENS를 올리세요."
        : reason === "content_filter"
          ? " — 제공자 필터에 걸렸습니다."
          : "";
    throw new Error(`LLM 빈 응답 (${detail})${hint}`);
  } catch (error) {
    probe.failure(error);
    throw error;
  } finally { probe.publish(opts.onDiagnostics); await recordAttempt(opts, probe.data, success); }
}

/** Strip ```json fences / prose and parse the first JSON object. Returns null on failure. */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  let s = text.trim();
  // remove ```json ... ``` or ``` ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // if there's surrounding prose, grab the outermost {...}
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
