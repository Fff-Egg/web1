import assert from "node:assert/strict";
import test from "node:test";
import type { ManualDigestRun, ManualDigestRequest } from "../src/shared/manualDigestRun.js";
import { createManualDigestRunner, manualFailureMetadata } from "../src/server/digest/manualRun.js";
import { resolveDigestSources } from "../src/server/digest/digestSources.js";
import { reportDigestProgress, reportDigestSources, withDigestProgress } from "../src/server/digest/progress.js";
import { digestRouter } from "../src/server/trpc/routers/digest.js";

const request: ManualDigestRequest = { start: "2026-09-19", end: "2026-09-19", fromDigests: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function memoryStore() {
  let saved: ManualDigestRun | null = null;
  return {
    async read() { return structuredClone(saved); },
    async write(run: ManualDigestRun) { saved = structuredClone(run); },
  };
}
const emptySources = { source: "none" as const, feedEligible: 0, savedDigests: 0, llmConfigured: true };

test("manual error logs retain database/network codes without private error contents", () => {
  const cause = Object.assign(new Error("secret SQL and key"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
  const error = new TypeError("provider prompt", { cause });
  assert.deepEqual(manualFailureMetadata(error), [{ name: "TypeError" }, { name: "Error", code: "ER_BAD_FIELD_ERROR", errno: 1054 }]);
  assert.doesNotMatch(JSON.stringify(manualFailureMetadata(error)), /secret|prompt|SQL|key/);
});

test("manual empty input finishes immediately with source counts and no synthesis", async () => {
  let synthesisCalls = 0;
  const store = memoryStore();
  const runner = createManualDigestRunner(store, async (_request, controls) => withDigestProgress(controls.progress, async () => {
    const input = await resolveDigestSources({ llmConfigured: true }, {
      feed: async () => [], digests: async () => [],
      emptyFeedDiagnostics: async () => ({ excluded: { review: 9, sourceReview: 2, trashed: 3 }, pendingAnalysis: 40, automaticAnalysisDeferred: true, analysisResumeHour: 13 }),
    });
    await reportDigestSources(input.counts);
    if (input.counts.source === "none") return null;
    synthesisCalls++;
    return { id: 1 };
  }, controls.sources));
  const first = await runner.start(request);
  const result = await first.completion;
  assert.equal(result.state, "empty");
  assert.match(result.message, /API를 호출하지 않았/);
  assert.equal(synthesisCalls, 0);
  assert.equal(result.sources?.excluded?.review, 9);
  assert.equal(result.sources?.pendingAnalysis, 40);
  assert.equal(result.sources?.analysisResumeHour, 13);
  assert.deepEqual(await store.read(), result);
  assert.equal(result.digestId, undefined);
});

test("manual 402 failure releases lock and same request can succeed after top-up", async () => {
  let calls = 0;
  const runner = createManualDigestRunner(memoryStore(), async () => {
    if (++calls === 1) throw new Error("whole article reading failed", { cause: new Error("HTTP 402 insufficient balance private-body") });
    return { id: 217 };
  });
  const first = await runner.start(request);
  const failed = await first.completion;
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /잔액 부족/);
  assert.doesNotMatch(failed.message, /private-body/);
  const retry = await runner.start(request);
  assert.equal(retry.reused, false);
  assert.notEqual(retry.job.id, first.job.id);
  const result = await retry.completion;
  assert.equal(result.state, "succeeded");
  assert.equal(result.digestId, 217);
});

test("concurrent manual presses reuse original range and one paid task", async () => {
  const gate = deferred<{ id: number }>();
  let calls = 0;
  const runner = createManualDigestRunner(memoryStore(), async (_request, controls) => {
    calls++;
    await controls.progress("API 응답 대기");
    return gate.promise;
  });
  const [first, second] = await Promise.all([
    runner.start(request), runner.start({ ...request, start: "2026-09-20", end: "2026-09-20" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.reused, true);
  assert.equal(second.job.request.start, request.start);
  assert.equal((await runner.status())?.state, "running");
  gate.resolve({ id: 220 });
  assert.equal((await first.completion).digestId, 220);
});

test("progress belongs to its job and saved report ID survives a later failure", async () => {
  const runner = createManualDigestRunner(memoryStore(), async (_request, controls) => withDigestProgress(controls.progress, async () => {
    await reportDigestSources({ ...emptySources, source: "feed", feedEligible: 2, savedDigests: null });
    await reportDigestProgress("저장 완료", 221);
    throw new Error("post-save error");
  }, controls.sources));
  const result = await (await runner.start(request)).completion;
  assert.equal(result.state, "failed");
  assert.equal(result.digestId, 221);
  assert.equal(result.sources?.feedEligible, 2);
});

test("persisted running task is interrupted after restart, without blocking a new press", async () => {
  const store = memoryStore();
  await store.write({ id: "old", request, state: "running", message: "old", startedAt: "old", updatedAt: "old" });
  const runner = createManualDigestRunner(store, async () => ({ id: 230 }));
  assert.equal((await runner.status())?.state, "interrupted");
  assert.equal((await store.read())?.state, "running", "status GET is read-only");
  const result = await (await runner.start(request)).completion;
  assert.equal(result.state, "succeeded");
  assert.equal(result.digestId, 230);
});

test("slow old status read cannot overwrite a retry completed during the read", async () => {
  const gate = deferred<ManualDigestRun | null>();
  const runner = createManualDigestRunner({ read: () => gate.promise, write: async () => {} }, async () => ({ id: 240 }));
  const reading = runner.status();
  const current = await (await runner.start(request)).completion;
  gate.resolve({ id: "old", request, state: "running", message: "stale", startedAt: "old", updatedAt: "old" });
  assert.equal((await reading)?.id, current.id);
  assert.equal((await runner.status())?.digestId, 240);
});

test("status persistence failure does not permanently lock manual retries", async () => {
  let fail = true;
  let calls = 0;
  const runner = createManualDigestRunner({
    read: async () => null,
    write: async () => { if (fail) throw new Error("database unavailable"); },
  }, async () => { calls++; return { id: 250 }; });
  await assert.rejects(runner.start(request), /database unavailable/);
  // Allow the failed start's finally/save to release its in-process task.
  await new Promise<void>((resolve) => setImmediate(resolve));
  fail = false;
  assert.equal((await (await runner.start(request)).completion).state, "succeeded");
  assert.equal(calls, 1);
});

test("source selection uses eligible feed before saved reports without extra diagnostic queries", async () => {
  const input = await resolveDigestSources({ llmConfigured: true }, {
    feed: async () => [{ id: 9 }],
    digests: async () => { throw new Error("should not query saved reports"); },
    emptyFeedDiagnostics: async () => { throw new Error("should not query diagnostics"); },
  });
  assert.equal(input.counts.source, "feed");
  assert.equal(input.counts.feedEligible, 1);
  assert.equal(input.counts.savedDigests, null);
});

test("empty manual feed falls back only to the requested saved reports", async () => {
  const input = await resolveDigestSources({ llmConfigured: true }, {
    feed: async () => [], digests: async () => [{ id: 7 }],
    emptyFeedDiagnostics: async () => ({ excluded: { review: 0, sourceReview: 0, trashed: 12 } }),
  });
  assert.equal(input.counts.source, "digests");
  assert.deepEqual(input.digests, [{ id: 7 }]);
  assert.equal(input.counts.savedDigests, 1);
});

test("explicit saved-report mode never reads feeds or backlog", async () => {
  const input = await resolveDigestSources({ fromDigests: true, llmConfigured: true }, {
    feed: async () => { throw new Error("should not read feeds"); }, digests: async () => [],
    emptyFeedDiagnostics: async () => { throw new Error("should not read backlog"); },
  });
  assert.deepEqual(input.counts, { ...emptySources, feedEligible: null });
});

test("automatic empty window still skips saved reports and diagnostics", async () => {
  const input = await resolveDigestSources({ auto: true, llmConfigured: true }, {
    feed: async () => [],
    digests: async () => { throw new Error("auto must not fall back"); },
    emptyFeedDiagnostics: async () => { throw new Error("auto must not add diagnostic workload"); },
  });
  assert.deepEqual(input.counts, { ...emptySources, savedDigests: null });
});

test("invalid or reversed manual dates are rejected before starting generation", async () => {
  const caller = digestRouter.createCaller({});
  for (const input of [
    { start: "2026-09-20", end: "2026-09-19" },
    { start: "2026-02-30" },
    { start: "not-a-date" },
  ]) await assert.rejects(caller.generate(input), (error: unknown) => error instanceof Error && "code" in error && error.code === "BAD_REQUEST");
});
