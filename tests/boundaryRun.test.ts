import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryRun } from "../src/shared/boundaryRun.js";
import { createBoundaryRunner, boundaryFailureMessage, performBoundaryWork } from "../src/server/digest/boundaryRun.js";
import { reportDigestProgress } from "../src/server/digest/progress.js";

function memoryStore() {
  const records = new Map<string, BoundaryRun>();
  return {
    records,
    async read(date: string) { return structuredClone(records.get(date) ?? null); },
    async write(run: BoundaryRun) { records.set(run.date, structuredClone(run)); },
  };
}
const result = { midday: "existing", morning: "created", swept: 0, sweepSkippedReason: null } as const;
const date = "2026-09-19";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("07시 API balance failure is visible and a press after top-up starts a fresh job", async () => {
  const store = memoryStore(); let calls = 0;
  const runner = createBoundaryRunner(store, async (_date, { progress }) => {
    calls++;
    if (calls === 1) throw Error("LLM API 402: provider request failed");
    await progress("아침분 저장", 219);
    return result;
  });
  const first = await runner.start(date);
  assert.equal((await first.completion).state, "failed");
  assert.match((await runner.status(date))!.message, /잔액 부족\(402\)/);
  const second = await runner.start(date);
  const completed = await second.completion;
  assert.notEqual(second.job.id, first.job.id); assert.equal(second.reused, false);
  assert.equal(calls, 2); assert.equal(completed.state, "succeeded");
  assert.deepEqual(completed.digestIds, [219]);
});

test("repeated 07시 presses and the cron share one live run, with persisted progress", async () => {
  const hold = deferred(); const store = memoryStore(); let calls = 0;
  const runner = createBoundaryRunner(store, async (_date, { progress }) => {
    calls++; await progress("아침분 작성 중"); await hold.promise; return result;
  });
  const [first, second] = await Promise.all([runner.start(date), runner.start(date)]);
  assert.equal(first.job.id, second.job.id); assert.equal(second.reused, true);
  assert.equal((await runner.status(date))?.state, "running");
  hold.resolve(); await first.completion;
  assert.equal(calls, 1); assert.equal(store.records.get(date)?.state, "succeeded");
});

test("empty or already-saved windows complete explicitly without waiting for a new list item", async () => {
  for (const state of ["empty", "existing"] as const) {
    const runner = createBoundaryRunner(memoryStore(), async () => ({ ...result, midday: state, morning: state }));
    const task = await runner.start(date); const end = await task.completion;
    assert.equal(end.state, "succeeded"); assert.deepEqual(end.digestIds, []);
    assert.match(end.message, state === "empty" ? /종합할 글 없음/ : /이미 저장됨/);
  }
});

test("a midway saved report does not finish the job; later failure retains its actual result id", async () => {
  const hold = deferred(); const runner = createBoundaryRunner(memoryStore(), async (_date, { progress }) => {
    await progress("낮분 저장", 218); await hold.promise; throw Error("LLM API 402: provider request failed");
  });
  const task = await runner.start(date);
  await new Promise(resolve => setImmediate(resolve));
  const working = await runner.status(date);
  assert.equal(working?.state, "running"); assert.deepEqual(working?.digestIds, [218]);
  hold.resolve(); const end = await task.completion;
  assert.equal(end.state, "failed"); assert.deepEqual(end.digestIds, [218]);
});

test("a restart marks the saved live flag interrupted, without preventing the next press", async () => {
  const store = memoryStore();
  await store.write({ id: "old-process", date, state: "running", message: "진행 중", startedAt: date, updatedAt: date, warnings: [], digestIds: [215] });
  const runner = createBoundaryRunner(store, async () => result);
  assert.equal((await runner.status(date))?.state, "interrupted");
  const task = await runner.start(date);
  assert.equal((await task.completion).state, "succeeded");
});

test("a failed status write releases the in-memory lock so retry remains possible", async () => {
  const store = memoryStore(); let unavailable = true;
  const runner = createBoundaryRunner({ read: store.read, write: async job => { if (unavailable) throw Error("database unavailable"); await store.write(job); } }, async () => result);
  await assert.rejects(runner.start(date), /database unavailable/);
  await new Promise(resolve => setImmediate(resolve)); unavailable = false;
  const retry = await runner.start(date); assert.equal((await retry.completion).state, "succeeded");
});

test("optional memo failure does not prevent the button from reaching report generation", async () => {
  const messages: string[] = []; const warnings: string[] = []; let reached = false;
  const run = await performBoundaryWork(date, { progress: async m => { messages.push(m); }, warn: async m => { warnings.push(m); } }, {
    memo: async () => { throw Error("memo save unavailable"); },
    digests: async received => {
      assert.equal(received, date); reached = true;
      await reportDigestProgress("아침분 확인");
      return { midday: null, evening: null, middayExisted: false, eveningExisted: false, swept: 0, sweepSkippedReason: null };
    },
  });
  assert.equal(reached, true); assert.equal(warnings.length, 1); assert.ok(messages.includes("아침분 확인"));
  assert.equal(run.morning, "empty");
});

test("button error text never publishes arbitrary provider bodies or credentials", () => {
  assert.doesNotMatch(boundaryFailureMessage(Error("LLM API 402 secret-prompt sk-sensitive")), /secret-prompt|sk-sensitive/);
  assert.doesNotMatch(boundaryFailureMessage(Error("database error password=hidden")), /password|hidden/);
});

test("a stale status read cannot overwrite a new completed retry", async () => {
  const store = memoryStore(); const hold = deferred();
  const stale: BoundaryRun = { id: "old", date, state: "running", message: "old", startedAt: date, updatedAt: date, warnings: [], digestIds: [] };
  let writes = 0;
  const runner = createBoundaryRunner({ read: async () => { await hold.promise; return stale; }, write: async value => { writes++; await store.write(value); } }, async () => result);
  const statusRead = runner.status(date);
  const current = await runner.start(date); await current.completion;
  const completedWrites = writes;
  hold.resolve(); const status = await statusRead;
  assert.equal(status?.id, current.job.id); assert.equal(status?.state, "succeeded");
  assert.equal(store.records.get(date)?.id, current.job.id); assert.equal(writes, completedWrites);
});

test("map-stage aggregate failures preserve API 402 for the button's balance message", async () => {
  const { mapStage } = await import("../src/server/digest/digest.js");
  const { newModelTrace } = await import("../src/server/digest/modelPipeline.js");
  const originalFetch = globalThis.fetch;
  const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.LLM_BASE_URL = "https://api.deepseek.com"; process.env.LLM_API_KEY = "test-only"; delete process.env.LLM_EXTRA_BODY;
    globalThis.fetch = async () => new Response("", { status: 402 });
    const rows = [{ id: 1, title: "본문", body: "내용", source: "출처", summary: "요약" }] as Parameters<typeof mapStage>[0];
    await assert.rejects(mapStage(rows, [[0]], "deepseek-flash", newModelTrace("deepseek-flash", "deepseek-flash")), error => {
      assert.match(boundaryFailureMessage(error), /잔액 부족\(402\)/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
