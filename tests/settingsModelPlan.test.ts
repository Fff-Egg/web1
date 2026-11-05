import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { settingsRouter } from "../src/server/trpc/routers/settings.js";
import { settingsRepo } from "../src/server/repo/settings.js";
import type { AnalysisConfig, Article } from "../src/server/db/schema.js";
import { filterRelevant } from "../src/server/analysis/analyze.js";

const originalGet = settingsRepo.getAnalysisConfig;
const originalSet = settingsRepo.setAnalysisConfig;
const originalFetch = globalThis.fetch;
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "FILTER_MODEL", "ANALYSIS_MODEL", "DIGEST_MAX_TOKENS",
  "DIGEST_FINAL_THINKING", "DIGEST_PRO_THINKING", "DIGEST_FINAL_THINKING_TOKENS", "DIGEST_PRO_THINKING_TOKENS", "FILTER_MAX_TOKENS", "LLM_EXTRA_BODY"] as const;
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  settingsRepo.getAnalysisConfig = originalGet;
  settingsRepo.setAnalysisConfig = originalSet;
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("saved stage switches persist across model changes and control the preview independently", async () => {
  const caller = setup();
  let saved: AnalysisConfig = await settingsRepo.getAnalysisConfig();
  settingsRepo.getAnalysisConfig = async () => saved;
  settingsRepo.setAnalysisConfig = async cfg => { saved = cfg; };
  await caller.updateAnalysisConfig({ ...saved, filterThinking: "enabled", digestMapThinking: "enabled", digestFinalThinking: "disabled" });
  let plan = await caller.getModelPlan();
  assert.equal(plan.filterThinking, "enabled"); assert.equal(plan.mapThinking, "enabled");
  assert.equal(plan.finalThinking, "disabled"); assert.equal(plan.finalTokens, 24576);
  assert.equal(plan.finalFallbackAvailable, false);
  await caller.updateAnalysisConfig({ ...saved, filterModel: "future-model-fixture", digestMapModel: "future-model-fixture", analysisModel: "future-model-fixture" });
  plan = await caller.getModelPlan();
  assert.equal(plan.filterThinking, "enabled"); assert.equal(plan.mapThinking, "enabled");
  assert.equal(plan.finalThinking, "disabled");
  await caller.updateAnalysisConfig({ ...saved, digestFinalThinking: "enabled", digestMapThinking: "disabled" });
  plan = await caller.getModelPlan();
  assert.equal(plan.finalFallbackAvailable, true); assert.equal(plan.finalFallbackTokens, 24576);
  assert.equal(plan.finalTokens, 49152);
  await assert.rejects(caller.updateAnalysisConfig({ ...saved, filterThinking: "unsupported" as "enabled" }));
});

function setup() {
  process.env.LLM_BASE_URL = "https://api.deepseek.com";
  process.env.LLM_API_KEY = "test-key";
  process.env.FILTER_MODEL = "deepseek-v4-flash";
  process.env.ANALYSIS_MODEL = "deepseek-v4-pro";
  process.env.DIGEST_MAX_TOKENS = "24576";
  process.env.DIGEST_PRO_THINKING_TOKENS = "24576";
  process.env.DIGEST_PRO_THINKING = "1";
  delete process.env.DIGEST_FINAL_THINKING;
  delete process.env.DIGEST_FINAL_THINKING_TOKENS;
  settingsRepo.getAnalysisConfig = async () => ({
    instructions: "", filterModel: "deepseek-flash", digestMapModel: "deepseek-flash", analysisModel: "deepseek-flash",
  });
  return settingsRouter.createCaller({});
}

test("saved Flash configuration overrides old Railway IDs and previews stage modes and actual budgets", async () => {
  const caller = setup();
  const plan = await caller.getModelPlan();
  for (const step of [plan.filter, plan.map, plan.final]) {
    assert.equal(step.effective, "deepseek-flash"); assert.equal(step.source, "web");
  }
  assert.equal(plan.filterThinking, "disabled"); assert.equal(plan.mapThinking, "disabled");
  assert.equal(plan.finalThinking, "enabled"); assert.equal(plan.finalTokens, 49152);
  assert.equal(plan.finalAttempts, 1); assert.equal(plan.finalFallbackAvailable, true);
  assert.equal(plan.finalFallbackTokens, 24576);
});

test("Settings respects new thinking overrides, legacy compatibility and same-mode fallback suppression", async () => {
  const caller = setup();
  process.env.DIGEST_FINAL_THINKING_TOKENS = "65536";
  assert.equal((await caller.getModelPlan()).finalTokens, 65536);
  process.env.DIGEST_FINAL_THINKING = "0";
  const disabled = await caller.getModelPlan();
  assert.equal(disabled.finalThinking, "disabled"); assert.equal(disabled.finalTokens, 24576);
  assert.equal(disabled.finalFallbackAvailable, false);
  delete process.env.DIGEST_FINAL_THINKING;
  delete process.env.DIGEST_FINAL_THINKING_TOKENS;
  process.env.DIGEST_PRO_THINKING_TOKENS = "57344";
  assert.equal((await caller.getModelPlan()).finalTokens, 57344);
});

test("article filter sends the saved thinking switch for a future model and reserves enough thinking budget", async () => {
  setup();
  process.env.FILTER_MAX_TOKENS = "600";
  process.env.LLM_EXTRA_BODY = JSON.stringify({ thinking: { type: "enabled" } });
  const bodies: any[] = [];
  const content = JSON.stringify({ relevant: true, important: true, summary: "전력 부족으로 데이터센터 허가가 지연됐다." });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return body.stream ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      : new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  };
  const article = { id: 1, title: "전력 부족", body: "전력 부족으로 데이터센터 허가가 6개월 지연됐다.", url: "https://example.com/article" } as Article;
  const cfg: AnalysisConfig = { instructions: "투자 정보를 분석한다.", filterModel: "future-model-fixture" };
  assert.equal((await filterRelevant(article, cfg)).relevant, true);
  assert.equal(bodies[0].thinking.type, "disabled"); assert.equal(bodies[0].max_tokens, 600);
  assert.equal((await filterRelevant(article, { ...cfg, filterThinking: "enabled" })).relevant, true);
  assert.equal(bodies[1].thinking.type, "enabled"); assert.equal(bodies[1].max_tokens, 49152);
  assert.equal(bodies[1].stream, true); assert.equal(bodies.length, 2);
});
