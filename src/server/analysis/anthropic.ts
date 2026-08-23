import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

/** True when an OpenAI-compatible endpoint (Groq / OpenRouter / Ollama …) is configured. */
function usingOpenAI(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
}

export type LlmProvider = "openai-compatible" | "anthropic" | "unconfigured";

/** Non-secret runtime provider label for the Settings diagnostics card. */
export function llmProvider(): LlmProvider {
  if (usingOpenAI()) return "openai-compatible";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "unconfigured";
}

/** Whether analysis can run — either Anthropic OR an OpenAI-compatible endpoint. */
export function hasLLM(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || usingOpenAI();
}

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
 */
export function resolveModel(model: string): string {
  const id = model.trim();
  return usingOpenAI() && id.startsWith("claude") ? OPENAI_DEFAULT_MODEL() : id;
}

export const FILTER_MODEL = () =>
  resolveModel(
    process.env.FILTER_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-haiku-4-5-20251001"),
  );
export const ANALYSIS_MODEL = () =>
  resolveModel(process.env.ANALYSIS_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-opus-4-8"));


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
 * 사고를 끄는 파라미터 이름은 제공자·모델마다 달라서 코드에 못 박지 않고 env로 뺀다.
 *   예) LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}
 *       LLM_EXTRA_BODY={"reasoning_effort":"none"}
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
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Single-turn helper: system prompt + user content -> assistant text. */
export async function complete(opts: CompleteOpts): Promise<string> {
  if (usingOpenAI()) {
    // Saved Settings may still carry Claude model ids (the old defaults); those
    // 404 on an OpenAI-compatible host, so fall back to the configured open model.
    const model = resolveModel(opts.model);
    return completeOpenAI({ ...opts, model });
  }
  return completeAnthropic(opts);
}

async function completeAnthropic(opts: CompleteOpts): Promise<string> {
  const res = await getAnthropic().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: stripLoneSurrogates(opts.system),
    messages: [{ role: "user", content: stripLoneSurrogates(opts.user) }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * OpenAI-compatible chat completions (Groq, OpenRouter, DeepInfra, Together,
 * local Ollama, …). Dependency-free — uses the built-in fetch. Configure with:
 *   LLM_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   LLM_API_KEY   the provider's API key
 *   LLM_MODEL     default model id (overridable per-pass via FILTER/ANALYSIS_MODEL)
 */
async function completeOpenAI(opts: CompleteOpts): Promise<string> {
  const base = process.env.LLM_BASE_URL!.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: 0,
      messages: [
        { role: "system", content: stripLoneSurrogates(opts.system) },
        { role: "user", content: stripLoneSurrogates(opts.user) },
      ],
      ...extraBody(),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: {
      message?: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const text = (choice?.message?.content ?? "").trim();
  if (text) {
    // 내용은 왔지만 한도에서 잘린 경우 — 조용히 반쪽짜리 결과를 쓰지 않도록 경고를 남긴다.
    if (choice?.finish_reason === "length") {
      const u = data.usage;
      console.warn(
        `[llm] 응답이 max_tokens(${opts.maxTokens ?? 1024})에서 잘림 (model=${opts.model}` +
          `${u ? `, completion=${u.completion_tokens ?? "?"}` : ""}) — 예산을 올리세요.`,
      );
    }
    return text;
  }

  // ⚠️ 200인데 본문이 빈 경우 — 예전엔 빈 문자열을 그대로 돌려줘 **조용히 통과**했다.
  // 그러면 다이제스트 맵 단계가 빈 청크를 만들고, 최종 종합은 "입력이 비어 있다"는
  // 쓸모없는 리포트를 저장한다(2026-08 실장애: "### 묶음 1" 제목만 남음).
  // 이제는 던져서 ① completeRetry가 재시도하고 ② 실패 시 원인이 화면·로그에 드러나게 한다.
  const reason = choice?.finish_reason ?? "?";
  const reasoning = (choice?.message?.reasoning_content ?? "").length;
  const u = data.usage;
  const detail =
    `finish_reason=${reason}` +
    (reasoning > 0 ? ` reasoning_len=${reasoning}` : "") +
    (u ? ` tokens(prompt=${u.prompt_tokens ?? "?"}, completion=${u.completion_tokens ?? "?"})` : "") +
    ` max_tokens=${opts.maxTokens ?? 1024}`;
  console.error(`[llm] 빈 응답 (model=${opts.model}) ${detail}`);
  const hint =
    reason === "length"
      ? " — 출력 토큰이 부족합니다(추론형 모델이면 사고 토큰이 예산을 다 씁니다). DIGEST_MAP_TOKENS·DIGEST_MAX_TOKENS를 올리세요."
      : reason === "content_filter"
        ? " — 제공자 필터에 걸렸습니다."
        : "";
  throw new Error(`LLM 빈 응답 (${detail})${hint}`);
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
