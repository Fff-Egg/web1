import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  complete,
  FILTER_MODEL,
  resolveModel,
} from "../src/server/analysis/anthropic.js";
import {
  completeDigestStage,
  newModelTrace,
  type CompleteFn,
} from "../src/server/digest/modelPipeline.js";

const KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "FILTER_MODEL"] as const;
const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of KEYS) {
    const value = before[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

function useDeepSeekEndpoint(): void {
  process.env.LLM_BASE_URL = "https://llm.example/v1";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "deepseek-v4-flash";
}

test("OpenAI 호환 환경의 오래된 Claude FILTER_MODEL은 실제 LLM_MODEL로 표시된다", () => {
  useDeepSeekEndpoint();
  process.env.FILTER_MODEL = "claude-haiku-4-5-20251001";
  assert.equal(resolveModel(process.env.FILTER_MODEL), "deepseek-v4-flash");
  assert.equal(FILTER_MODEL(), "deepseek-v4-flash");
});

test("본문이 있어도 finish_reason=length면 잘린 결과를 성공으로 저장하지 않는다", async () => {
  useDeepSeekEndpoint();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "## 오늘의 핵심\n작성 도중 끊긴 문장" }, finish_reason: "length" }],
        usage: { prompt_tokens: 5000, completion_tokens: 12_288 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  await assert.rejects(
    complete({ model: "deepseek-v4-pro", system: "s", user: "u", maxTokens: 12_288 }),
    /finish_reason=length.*부분 결과는 저장하지 않습니다/,
  );
});

test("실제 length 응답은 증액된 같은 Pro 재시도로 완성본을 받는다", async () => {
  useDeepSeekEndpoint();
  const requestedTokens: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens: number };
    requestedTokens.push(body.max_tokens);
    const first = requestedTokens.length === 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: first ? "중간에서 끊긴 결과" : "모든 섹션이 들어간 완성본" },
            finish_reason: first ? "length" : "stop",
          },
        ],
        usage: { prompt_tokens: 5000, completion_tokens: body.max_tokens },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");

  const result = await completeDigestStage(
    { model: "deepseek-v4-pro", system: "s", user: "u", maxTokens: 12_288 },
    { stage: "final", fallbackModel: "deepseek-v4-flash", retryMaxTokens: 24_576 },
    trace,
  );

  assert.equal(result, "모든 섹션이 들어간 완성본");
  assert.deepEqual(requestedTokens, [12_288, 24_576]);
  assert.deepEqual(trace.stages.final.used, ["deepseek-v4-pro"]);
  assert.equal(trace.stages.final.retries, 1);
  assert.equal(trace.stages.final.fallbacks, 0);
});

test("최종 Pro가 토큰 부족이면 예산을 늘려 같은 Pro로 먼저 재시도한다", async () => {
  useDeepSeekEndpoint();
  const calls: Array<{ model: string; maxTokens?: number }> = [];
  const invoke: CompleteFn = async (opts) => {
    calls.push({ model: opts.model, maxTokens: opts.maxTokens });
    if (calls.length === 1) throw new Error("LLM 빈 응답 (finish_reason=length)");
    return "pro result";
  };
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");
  const result = await completeDigestStage(
    { model: "deepseek-v4-pro", system: "s", user: "u", maxTokens: 12_288 },
    { stage: "final", fallbackModel: "deepseek-v4-flash", retryMaxTokens: 24_576 },
    trace,
    invoke,
  );

  assert.equal(result, "pro result");
  assert.deepEqual(calls, [
    { model: "deepseek-v4-pro", maxTokens: 12_288 },
    { model: "deepseek-v4-pro", maxTokens: 24_576 },
  ]);
  assert.deepEqual(trace.stages.final.used, ["deepseek-v4-pro"]);
  assert.equal(trace.stages.final.retries, 1);
  assert.equal(trace.stages.final.fallbacks, 0);
});

test("최종 Pro가 두 번 모두 실패한 뒤에만 Flash가 최종 작성한다", async () => {
  useDeepSeekEndpoint();
  const calls: string[] = [];
  const invoke: CompleteFn = async (opts) => {
    calls.push(opts.model);
    if (opts.model === "deepseek-v4-pro") throw new Error("temporary pro failure");
    return "flash emergency result";
  };
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");
  const result = await completeDigestStage(
    { model: "deepseek-v4-pro", system: "s", user: "u", maxTokens: 12_288 },
    { stage: "final", fallbackModel: "deepseek-v4-flash", retryMaxTokens: 24_576 },
    trace,
    invoke,
  );

  assert.equal(result, "flash emergency result");
  assert.deepEqual(calls, ["deepseek-v4-pro", "deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.deepEqual(trace.stages.final.used, ["deepseek-v4-flash"]);
  assert.equal(trace.stages.final.fallbacks, 1);
  assert.equal(trace.fallbacks, 1);
});

test("자료 정리 단계는 Flash만 재시도하고 Pro로 역폴백하지 않는다", async () => {
  useDeepSeekEndpoint();
  const calls: string[] = [];
  const invoke: CompleteFn = async (opts) => {
    calls.push(opts.model);
    throw new Error("map unavailable");
  };
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");

  await assert.rejects(
    completeDigestStage(
      { model: "deepseek-v4-flash", system: "s", user: "u", maxTokens: 5_000 },
      { stage: "map", retryMaxTokens: 10_000 },
      trace,
      invoke,
    ),
    /map unavailable/,
  );
  assert.deepEqual(calls, ["deepseek-v4-flash", "deepseek-v4-flash"]);
  assert.equal(trace.stages.map.failures, 1);
  assert.equal(trace.stages.map.fallbacks, 0);
});

test("의도된 Flash 자료 정리와 Pro 최종 종합은 폴백 없이 단계별 기록된다", async () => {
  useDeepSeekEndpoint();
  const invoke: CompleteFn = async (opts) => `${opts.model} result`;
  const trace = newModelTrace("deepseek-v4-flash", "deepseek-v4-pro");

  await completeDigestStage(
    { model: "deepseek-v4-flash", system: "s", user: "map", maxTokens: 5_000 },
    { stage: "map", retryMaxTokens: 10_000 },
    trace,
    invoke,
  );
  await completeDigestStage(
    { model: "deepseek-v4-pro", system: "s", user: "final", maxTokens: 12_288 },
    { stage: "final", fallbackModel: "deepseek-v4-flash", retryMaxTokens: 24_576 },
    trace,
    invoke,
  );

  assert.deepEqual(trace.stages.map.used, ["deepseek-v4-flash"]);
  assert.deepEqual(trace.stages.final.used, ["deepseek-v4-pro"]);
  assert.deepEqual(trace.used, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(trace.fallbacks, 0);
  assert.equal(trace.failures, 0);
});
