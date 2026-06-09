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

export interface CompleteOpts {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Single-turn helper: system prompt + user content -> assistant text. */
export async function complete(opts: CompleteOpts): Promise<string> {
  if (usingOpenAI()) return completeOpenAI(opts);
  return completeAnthropic(opts);
}

async function completeAnthropic(opts: CompleteOpts): Promise<string> {
  const res = await getAnthropic().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
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
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
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
