import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

/** Whether analysis can run (API key present). */
export function hasAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getAnthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export const FILTER_MODEL = () => process.env.FILTER_MODEL ?? "claude-haiku-4-5-20251001";
export const ANALYSIS_MODEL = () => process.env.ANALYSIS_MODEL ?? "claude-opus-4-8";

/** Single-turn helper: system prompt + user content -> assistant text. */
export async function complete(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
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
