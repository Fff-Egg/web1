import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

/** True when an OpenAI-compatible endpoint (Groq / OpenRouter / Ollama …) is configured. */
function usingOpenAI(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
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
export const FILTER_MODEL = () =>
  process.env.FILTER_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-haiku-4-5-20251001");
export const ANALYSIS_MODEL = () =>
  process.env.ANALYSIS_MODEL ?? (usingOpenAI() ? OPENAI_DEFAULT_MODEL() : "claude-opus-4-8");


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
    const model = opts.model.startsWith("claude") ? OPENAI_DEFAULT_MODEL() : opts.model;
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
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
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
