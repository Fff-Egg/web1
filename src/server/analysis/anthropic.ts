import Anthropic from "@anthropic-ai/sdk";
import { LlmCallProbe } from "./llmDiagnostics.js";
import { readChatCompletionStream } from "./chatCompletionStream.js";
import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";
import { supportsDeepSeekThinking } from "../../shared/deepseekModels.js";
import type { LlmUsageContext, LlmUsageEvent } from "../../shared/llmUsage.js";
import { currentLlmUsageContext, observeLlmUsage } from "./usageObservation.js";
import { recordProviderUsage, tokenCount } from "./providerUsage.js";
import { LlmOutputLimitError } from "./llmErrors.js";
import { diagnoseProviderError, LlmProviderError } from "./providerError.js";
import { effortFor, isClaudeModel, type ClaudeEffort } from "../../shared/llmModels.js";

let _client: Anthropic | null = null;

/** True when an OpenAI-compatible endpoint (DeepSeek / Groq / OpenRouter …) is configured. */
function usingOpenAI(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
}

/** True when the Anthropic Claude API key is configured. */
function usingAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type LlmProvider = "openai-compatible" | "anthropic" | "mixed" | "unconfigured";

/** Non-secret runtime provider label for the Settings diagnostics card. */
export function llmProvider(): LlmProvider {
  if (usingOpenAI() && usingAnthropic()) return "mixed";
  if (usingOpenAI()) return "openai-compatible";
  if (usingAnthropic()) return "anthropic";
  return "unconfigured";
}

/** Whether analysis can run — either Anthropic OR an OpenAI-compatible endpoint. */
export function hasLLM(): boolean {
  return usingAnthropic() || usingOpenAI();
}

/** @deprecated kept for back-compat; prefer hasLLM(). */
export function hasAnthropic(): boolean {
  return hasLLM();
}

export function getAnthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey, maxRetries: 2 });
  }
  return _client;
}

/** Test hook: replace (or reset with null) the cached Claude client. */
export function setAnthropicClientForTests(client: Anthropic | null): void {
  _client = client;
}

// Model defaults depend on the active provider. With an OpenAI-compatible
// endpoint, set LLM_MODEL (or FILTER_MODEL / ANALYSIS_MODEL) to that host's id
// (e.g. "deepseek-flash").
const OPENAI_DEFAULT_MODEL = () => process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";

/**
 * The provider is chosen per call from the model ID: `claude-*` goes to the
 * Claude API when ANTHROPIC_API_KEY is set; every other ID goes to the
 * OpenAI-compatible endpoint. This lets Settings mix providers per stage
 * (e.g. Claude Sonnet filter + Claude Opus final, or DeepSeek filter + Claude final).
 */
export function providerFor(model: string): "anthropic" | "openai-compatible" {
  const id = model.trim();
  if (isClaudeModel(id) && usingAnthropic()) return "anthropic";
  if (usingOpenAI()) return "openai-compatible";
  return "anthropic";
}

/**
 * Return the model id that will actually be sent to its provider.
 *
 * Old Settings/Railway values may still contain a `claude-*` id while only an
 * OpenAI-compatible endpoint is configured. Without an Anthropic key that id
 * would 404, so it is replaced with LLM_MODEL (the long-standing behaviour).
 * With ANTHROPIC_API_KEY set, Claude ids are sent to Claude unchanged.
 */
export function resolveModel(model: string): string {
  const id = model.trim();
  return providerFor(id) === "openai-compatible" && isClaudeModel(id) ? OPENAI_DEFAULT_MODEL() : id;
}

/** DeepSeek thinking ON/OFF protocol support; Claude uses effort levels instead. */
export function supportsThinkingControl(model: string): boolean {
  return providerFor(model) === "openai-compatible" && supportsDeepSeekThinking(process.env.LLM_BASE_URL, resolveModel(model));
}

export const FILTER_MODEL = () =>
  resolveModel(
    process.env.FILTER_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-sonnet-5-5"),
  );
export const ANALYSIS_MODEL = () =>
  resolveModel(process.env.ANALYSIS_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-opus-5-5"));


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
  /** DeepSeek V4 per-call thinking switch. Ignored by providers/models that do not support it. */
  thinking?: "enabled" | "disabled";
  /** Claude reasoning effort for this stage. Ignored by non-Claude models. */
  effort?: ClaudeEffort;
}

/** Single-turn helper: system prompt + user content -> assistant text. */
export async function complete(opts: CompleteOpts): Promise<string> {
  if (providerFor(opts.model) === "openai-compatible") {
    // Saved Settings may still carry Claude model ids while only an
    // OpenAI-compatible host is configured; resolveModel maps those to LLM_MODEL.
    const model = resolveModel(opts.model);
    return completeOpenAI({ ...opts, model });
  }
  return completeAnthropic(opts);
}

/** Thinking shares max_tokens with the answer, so Claude calls get a generous ceiling.
 * It is a cap, not a target: only generated tokens are billed. */
export const CLAUDE_MIN_MAX_TOKENS = 16_000;
const CLAUDE_MAX_OUTPUT_TOKENS = 128_000;
export function claudeMaxTokens(requested?: number): number {
  const asked = Number.isFinite(requested) && (requested ?? 0) > 0 ? Math.floor(requested!) : 0;
  return Math.min(CLAUDE_MAX_OUTPUT_TOKENS, Math.max(CLAUDE_MIN_MAX_TOKENS, asked));
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Wrap SDK HTTP errors into the shared contract: `LLM API <status>:` + a finite category. */
function anthropicFailure(error: unknown, probe: LlmCallProbe): unknown {
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    // Inspect the provider body only in memory; store just the fixed category.
    const diagnosis = diagnoseProviderError(JSON.stringify(error.error ?? {}), error.status);
    probe.data.httpStatus = error.status;
    probe.data.errorCategory = diagnosis.category;
    probe.data.errorParam = diagnosis.param;
    return new LlmProviderError(error.status, diagnosis);
  }
  return error;
}

async function completeAnthropic(opts: CompleteOpts): Promise<string> {
  const probe = new LlmCallProbe(opts.system, opts.user);
  const model = opts.model.trim();
  const effort = effortFor(model, opts.effort);
  const maxTokens = claudeMaxTokens(opts.maxTokens);
  probe.data.endpointHost = "api.anthropic.com";
  probe.data.effectiveModel = model;
  // Current Claude models run adaptive thinking; depth is set by effort.
  probe.data.effectiveThinking = "enabled";
  probe.data.effectiveMaxTokens = maxTokens;
  probe.data.stream = true;
  let success = false;
  try {
    const useFallback = SERVER_FALLBACK_MODELS.has(model);
    const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      // The stage instructions repeat on every call — cache them (reads bill at ~10%).
      system: [{ type: "text", text: stripLoneSurrogates(opts.system), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: stripLoneSurrogates(opts.user) }],
      thinking: { type: "adaptive" },
      ...(effort ? { output_config: { effort } } : {}),
      ...(useFallback ? { fallbacks: "default" as const, betas: [SERVER_FALLBACK_BETA] } : {}),
      stream: true,
    };
    probe.data.requestBytes = Buffer.byteLength(JSON.stringify(params));
    probe.data.stage = "awaiting_headers";
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      // Streaming avoids HTTP timeouts on long thinking/report generations.
      const { stream: _stream, ...streamParams } = params;
      res = await getAnthropic().beta.messages.stream(streamParams).finalMessage();
    } catch (error) {
      throw anthropicFailure(error, probe);
    }
    probe.data.stage = "validating_response";
    const usage = res.usage;
    const input = tokenCount(usage.input_tokens);
    const hit = tokenCount(usage.cache_read_input_tokens ?? 0);
    const creation = tokenCount(usage.cache_creation_input_tokens ?? 0);
    if (input !== undefined && hit !== undefined && creation !== undefined) {
      probe.data.promptTokens = input + hit + creation;
      probe.data.cacheHitTokens = hit;
      // Uncached input incl. cache writes (writes bill ~1.25x; estimate treats them as input).
      probe.data.cacheMissTokens = input + creation;
    }
    probe.data.completionTokens = tokenCount(usage.output_tokens);
    probe.data.reasoningTokens = tokenCount(usage.output_tokens_details?.thinking_tokens);
    if (typeof res.model === "string" && /^[\w./:-]{1,160}$/.test(res.model)) probe.data.effectiveModel = res.model;
    const reason = res.stop_reason ?? "unknown";
    probe.data.finishReason = /^[a-z_]{1,40}$/.test(reason) ? reason : "unknown";
    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    probe.data.contentChars = text.length;
    const detail = `stop_reason=${reason} tokens(output=${usage.output_tokens ?? "?"}) max_tokens=${maxTokens}`;
    if (reason === "max_tokens") {
      console.warn(`[llm] 불완전 응답 폐기 (model=${model}) ${detail}`);
      throw new LlmOutputLimitError(`LLM 응답 잘림 (finish_reason=length ${detail}) — 부분 결과는 저장하지 않습니다.`);
    }
    if (reason === "refusal") {
      // The server-side fallback (if any) also declined. Treat like a policy rejection.
      probe.data.httpStatus = 400;
      probe.data.errorCategory = "content_policy";
      throw new LlmProviderError(400, { category: "content_policy", param: null });
    }
    if (!text) {
      console.error(`[llm] 빈 응답 (model=${model}) ${detail}`);
      throw new Error(`LLM 빈 응답 (${detail})`);
    }
    probe.data.stage = "complete";
    success = true;
    return text;
  } catch (error) { probe.failure(error); throw error; }
  finally { probe.publish(opts.onDiagnostics); await recordAttempt(opts, probe.data, success); }
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
