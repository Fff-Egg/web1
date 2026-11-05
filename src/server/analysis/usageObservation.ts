import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmUsageContext, LlmUsageEvent } from "../../shared/llmUsage.js";

export type UsageSink = (event: LlmUsageEvent) => Promise<void> | void;
const sinks = new AsyncLocalStorage<UsageSink>();
const contexts = new AsyncLocalStorage<Partial<LlmUsageContext>>();
export function withLlmUsageContext<T>(context: Partial<LlmUsageContext>, fn: () => T): T {
  return contexts.run({ ...contexts.getStore(), ...context }, fn);
}
export function currentLlmUsageContext(): Partial<LlmUsageContext> { return contexts.getStore() ?? {}; }
/** Scoped injection also keeps concurrent test/request observers isolated. */
export function withLlmUsageSink<T>(sink: UsageSink, fn: () => T): T { return sinks.run(sink, fn); }

let pending = 0;
// Allow normal filter/map bursts while bounding queued writes during an outage.
const MAX_PENDING = 32;
function fallback(event: LlmUsageEvent): void {
  // Explicit event shape contains metadata and counters only, never error bodies or prompts.
  try { console.warn(`[llm-usage] persist_unavailable ${JSON.stringify(event)}`); } catch { /* observation only */ }
}
async function defaultSink(event: LlmUsageEvent): Promise<void> {
  const { saveLlmUsageEvent } = await import("../repo/llmUsage.js");
  await saveLlmUsageEvent(event);
}
/** Bounded observer: a broken/slow ledger must never turn a successful LLM into a paid retry. */
export async function observeLlmUsage(event: LlmUsageEvent, timeoutMs = 750): Promise<void> {
  if (pending >= MAX_PENDING) { fallback(event); return; }
  pending++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  const warn = () => { if (!warned) { warned = true; fallback(event); } };
  const work = Promise.resolve().then(() => (sinks.getStore() ?? defaultSink)(event))
    .catch(warn).finally(() => { pending--; });
  try {
    await Promise.race([work, new Promise<void>(resolve => {
      timer = setTimeout(() => { warn(); resolve(); }, timeoutMs);
    })]);
  } catch { warn(); }
  finally { if (timer) clearTimeout(timer); }
}
