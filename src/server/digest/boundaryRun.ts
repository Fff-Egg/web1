import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { BoundaryRun } from "../../shared/boundaryRun.js";
import { classifyDigestFailure } from "./modelPipeline.js";
import { kstToday, runDailyDigests } from "./digest.js";
import { feedbackRepo } from "../repo/feedback.js";
import { withDigestProgress, type DigestProgress } from "./progress.js";

/** Fixed messages: provider errors may contain prompts/keys, so never expose their body. */
export function boundaryFailureMessage(error: unknown): string {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  for (let cause = error; cause && !seen.has(cause) && chain.length < 5;) {
    seen.add(cause);
    chain.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  const detail = chain.join("; ");
  if (/\b402\b|insufficient.?balance|insufficient.?credit/i.test(detail)) {
    return "API 제공자가 잔액 부족(402)을 응답했습니다. 연결된 API 계정에 충전이 반영됐는지 확인한 뒤 다시 실행하세요.";
  }
  const messages = {
    authentication: "API 인증에 실패했습니다. 연결된 API 키와 계정 상태를 확인한 뒤 다시 실행하세요.",
    rate_limit: "API 요청 한도에 걸렸습니다. 잠시 후 다시 실행하세요.",
    network: "API 연결이 끊겨 작업이 중단됐습니다. 다시 실행할 수 있습니다.",
    timeout: "API 응답 대기 시간이 초과됐습니다. 다시 실행할 수 있습니다.",
    provider_5xx: "API 제공자 오류로 작업이 중단됐습니다. 잠시 후 다시 실행하세요.",
    token_limit: "API 응답이 토큰 한도에서 잘려 보고서를 저장하지 못했습니다.",
    bad_request: "API 요청이 거절됐습니다. 모델 설정을 확인한 뒤 다시 실행하세요.",
    content_filter: "API 제공자의 콘텐츠 제한으로 작업이 중단됐습니다.",
    empty_response: "API가 빈 응답을 반환해 작업이 중단됐습니다.",
    thinking_only_empty: "API가 보고서 본문을 반환하지 않아 작업이 중단됐습니다.",
    unknown: "작업을 완료하지 못했습니다. 실행 번호로 서버 로그를 확인할 수 있습니다.",
  };
  return messages[classifyDigestFailure(new Error(detail))];
}

interface RunStore {
  read(date: string): Promise<BoundaryRun | null>;
  write(run: BoundaryRun): Promise<void>;
}
interface Controls { progress: DigestProgress; warn(message: string): Promise<void> }
type Work = (date: string, controls: Controls) => Promise<NonNullable<BoundaryRun["result"]>>;

/** One shared in-process execution for cron and repeated manual presses. Completed
 * failures are not locks: a press after a balance top-up always starts a new run. */
export function createBoundaryRunner(store: RunStore, work: Work) {
  const active = new Map<string, { run: BoundaryRun; ready: Promise<void>; completion: Promise<BoundaryRun> }>();
  const recent = new Map<string, BoundaryRun>();
  return {
    async status(date: string): Promise<BoundaryRun | null> {
      const local = active.get(date)?.run ?? recent.get(date);
      if (local) return structuredClone(local);
      const saved = await store.read(date);
      const startedDuringRead = active.get(date)?.run ?? recent.get(date);
      if (startedDuringRead) return structuredClone(startedDuringRead);
      if (saved?.state === "running") {
        // This process owns no task for the saved record: a deployment/restart
        // interrupted it. Never mistake a stale persisted flag for a live lock.
        // A status GET must not overwrite a newer run racing with this read.
        return { ...saved, state: "interrupted",
          message: "서버 재시작으로 이전 작업이 중단됐습니다. 다시 실행할 수 있습니다." };
      }
      return saved;
    },
    async start(date: string) {
      const previous = active.get(date);
      if (previous) {
        await previous.ready;
        return { job: structuredClone(previous.run), reused: true, completion: previous.completion };
      }
      const now = new Date().toISOString();
      const run: BoundaryRun = { id: randomUUID(), date, state: "running", message: "작업을 준비하고 있습니다.",
        startedAt: now, updatedAt: now, warnings: [], digestIds: [] };
      let writes = Promise.resolve();
      const save = () => {
        run.updatedAt = new Date().toISOString();
        const snapshot = structuredClone(run);
        writes = writes.then(() => store.write(snapshot));
        return writes;
      };
      const ready = save();
      const progress: DigestProgress = async (message, digestId) => {
        run.message = message;
        if (digestId && !run.digestIds.includes(digestId)) run.digestIds.push(digestId);
        await save();
      };
      const warn = async (message: string) => { run.warnings.push(message); await save(); };
      const completion = (async () => {
        try {
          await ready;
          run.result = await work(date, { progress, warn });
          run.state = "succeeded";
          const label = { created: "생성 완료", existing: "이미 저장됨", empty: "종합할 글 없음" };
          run.message = `아침분: ${label[run.result.morning]} · 낮분: ${label[run.result.midday]}`;
        } catch (error) {
          run.state = "failed";
          run.message = boundaryFailureMessage(error);
          console.error(`[boundary:${run.id}] failed: ${run.message}`);
        } finally {
          run.finishedAt = new Date().toISOString();
          // A temporary status-write failure must not leave the in-memory lock.
          writes = writes.catch(() => {});
          try { await save(); } catch { console.error(`[boundary:${run.id}] status save failed`); }
          recent.set(date, structuredClone(run));
          if (recent.size > 7) recent.delete(recent.keys().next().value!);
          active.delete(date);
        }
        return structuredClone(run);
      })();
      active.set(date, { run, ready, completion });
      await ready;
      return { job: structuredClone(run), reused: false, completion };
    },
  };
}

const memory = new Map<string, BoundaryRun>();
const store: RunStore = {
  async read(date) {
    if (!hasDb) return memory.get(date) ?? null;
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `boundaryRun:${date}`)).limit(1);
    return (row?.value as unknown as BoundaryRun) ?? null;
  },
  async write(run) {
    if (!hasDb) { memory.set(run.date, structuredClone(run)); return; }
    const value = run as unknown as Record<string, unknown>;
    await db.insert(settings).values({ key: `boundaryRun:${run.date}`, value }).onDuplicateKeyUpdate({ set: { value } });
  },
};

/** Keep the memo optional, matching the existing automatic boundary routine. */
export async function performBoundaryWork(
  date: string, controls: Controls,
  deps = { memo: () => feedbackRepo.refreshGuidance(), digests: runDailyDigests },
): Promise<NonNullable<BoundaryRun["result"]>> {
  await controls.progress("학습 메모를 확인하고 있습니다.");
  try { await deps.memo(); }
  catch { await controls.warn("학습 메모 갱신에 실패해 기존 메모를 유지하고 보고서 생성을 진행합니다."); }
  await controls.progress("낮분 보충과 아침분 생성을 시작합니다.");
  const run = await withDigestProgress(controls.progress, () => deps.digests(date));
  return {
    midday: run.midday ? "created" : run.middayExisted ? "existing" : "empty",
    morning: run.evening ? "created" : run.eveningExisted ? "existing" : "empty",
    swept: run.swept, sweepSkippedReason: run.sweepSkippedReason,
  };
}

export const boundaryRunner = createBoundaryRunner(store, performBoundaryWork);
export const startBoundaryRun = (date = kstToday()) => boundaryRunner.start(date);
