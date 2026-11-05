import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { ManualDigestRequest, ManualDigestRun, DigestSourceCounts } from "../../shared/manualDigestRun.js";
import { generateDigest } from "./digest.js";
import { boundaryFailureMessage } from "./boundaryRun.js";
import { withDigestProgress, type DigestProgress } from "./progress.js";

interface Store {
  read(): Promise<ManualDigestRun | null>;
  write(run: ManualDigestRun): Promise<void>;
}
interface Controls {
  progress: DigestProgress;
  sources(counts: DigestSourceCounts): Promise<void>;
}
type Work = (request: ManualDigestRequest, controls: Controls) => Promise<{ id: number } | null>;
class MissingDatabaseError extends Error {}

/** Keep pre-API failures diagnosable without logging provider bodies, SQL,
 * prompts, request headers, or keys carried in arbitrary error messages. */
export function manualFailureMetadata(error: unknown) {
  const details: { name?: string; code?: string; errno?: number }[] = [];
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause) && details.length < 5;) {
    seen.add(cause);
    const item = cause as { name?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
    details.push({
      ...(typeof item.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.name) ? { name: item.name } : {}),
      ...(typeof item.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) ? { code: item.code } : {}),
      ...(typeof item.errno === "number" && Number.isFinite(item.errno) ? { errno: item.errno } : {}),
    });
    cause = item.cause;
  }
  return details;
}

/** A manual press starts one explicit request. While it runs, subsequent presses
 * return that same request (including its dates), avoiding duplicate paid work.
 * The latest status is a single settings row; completed failures never lock retries.
 * Like boundaryRunner this assumes the existing single-process deployment. */
export function createManualDigestRunner(store: Store, work: Work) {
  let active: { run: ManualDigestRun; ready: Promise<void>; completion: Promise<ManualDigestRun> } | undefined;
  let recent: ManualDigestRun | undefined;
  const current = () => active?.run ?? recent;
  return {
    async status(): Promise<ManualDigestRun | null> {
      const local = current();
      if (local) return structuredClone(local);
      const saved = await store.read();
      // A GET started before a new press must not replace its ACK with old data.
      const startedDuringRead = current();
      if (startedDuringRead) return structuredClone(startedDuringRead);
      return saved?.state === "running"
        ? { ...saved, state: "interrupted", message: "서버 재시작으로 이전 생성이 중단됐습니다. 같은 기간으로 다시 생성할 수 있습니다." }
        : saved;
    },
    async start(request: ManualDigestRequest) {
      if (active) {
        const previous = active;
        await previous.ready;
        return { job: structuredClone(previous.run), reused: true, completion: previous.completion };
      }
      const now = new Date().toISOString();
      const run: ManualDigestRun = {
        id: randomUUID(), request: structuredClone(request), state: "running",
        message: "선택한 기간의 생성 대상을 확인하고 있습니다.", startedAt: now, updatedAt: now,
      };
      let writes = Promise.resolve();
      const save = () => {
        run.updatedAt = new Date().toISOString();
        const snapshot = structuredClone(run);
        writes = writes.then(() => store.write(snapshot));
        return writes;
      };
      const ready = save();
      const controls: Controls = {
        async progress(message, id) {
          run.message = message;
          if (id !== undefined) run.digestId = id;
          await save();
        },
        async sources(counts) { run.sources = structuredClone(counts); await save(); },
      };
      const completion = (async () => {
        try {
          await ready;
          const result = await work(run.request, controls);
          if (result) {
            run.digestId = result.id;
            run.state = "succeeded";
            run.message = run.sources?.llmConfigured === false
              ? "LLM API가 설정되어 있지 않아 기본 목록 보고서를 저장했습니다."
              : "다이제스트를 저장했습니다.";
          } else {
            run.state = "empty";
            run.message = run.request.fromDigests
              ? "선택한 기간에 저장된 다이제스트가 없어 API를 호출하지 않았습니다."
              : "선택한 기간에 종합할 중요·저장 피드와 저장된 다이제스트가 없어 API를 호출하지 않았습니다.";
          }
        } catch (error) {
          const phase = run.message;
          run.state = "failed";
          run.message = error instanceof MissingDatabaseError
            ? "데이터베이스가 연결되어 있지 않아 생성할 수 없습니다. 서버 설정을 확인하세요."
            : boundaryFailureMessage(error);
          console.error(`[manual-digest:${run.id}] failed: ${run.message}`, { phase, errors: manualFailureMetadata(error) });
        } finally {
          run.finishedAt = new Date().toISOString();
          writes = writes.catch(() => {});
          try { await save(); } catch { console.error(`[manual-digest:${run.id}] status save failed`); }
          recent = structuredClone(run);
          active = undefined;
        }
        return structuredClone(run);
      })();
      active = { run, ready, completion };
      await ready;
      return { job: structuredClone(run), reused: false, completion };
    },
  };
}

let memory: ManualDigestRun | null = null;
const store: Store = {
  async read() {
    if (!hasDb) return memory;
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "manualDigestRun")).limit(1);
    return (row?.value as unknown as ManualDigestRun) ?? null;
  },
  async write(run) {
    if (!hasDb) { memory = structuredClone(run); return; }
    const value = run as unknown as Record<string, unknown>;
    await db.insert(settings).values({ key: "manualDigestRun", value }).onDuplicateKeyUpdate({ set: { value } });
  },
};

export const manualDigestRunner = createManualDigestRunner(store, async (request, controls) => {
  if (!hasDb) throw new MissingDatabaseError();
  return withDigestProgress(controls.progress, () => generateDigest(request), controls.sources);
});
