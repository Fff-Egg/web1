import { z } from "zod";
import { and, desc, eq, gte, lt, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { digests, analyses, articles } from "../../db/schema.js";
import {
  generateDigest,
  kstToday,
  kstHour,
  kstRangeBounds,
  sweepWindow,
  runDailyDigests,
  runMiddayDigest,
  hasMiddayFor,
  middayHour,
  middayLabelDate,
  digestHour,
  currentWindowDate,
  slotBounds,
} from "../../digest/digest.js";
import { feedbackRepo } from "../../repo/feedback.js";

const summarySelect = {
  id: digests.id,
  title: digests.title,
  periodStart: digests.periodStart,
  periodEnd: digests.periodEnd,
  createdAt: digests.createdAt,
  // meta carries { auto, source, model, ... } so the UI can group/badge digests.
  meta: digests.meta,
};

/** digest router — saved reports with custom period + name, plus trash. */
export const digestRouter = router({
  /** Saved (non-trashed) digests, newest first. */
  list: publicProcedure.query(async () => {
    if (!hasDb) return [];
    return db
      .select(summarySelect)
      .from(digests)
      .where(isNull(digests.deletedAt))
      .orderBy(desc(digests.createdAt));
  }),

  /** Soft-deleted digests (trash). */
  trash: publicProcedure.query(async () => {
    if (!hasDb) return [];
    return db
      .select(summarySelect)
      .from(digests)
      .where(isNotNull(digests.deletedAt))
      .orderBy(desc(digests.createdAt));
  }),

  /** A single digest by id, or the latest non-trashed one if omitted. */
  get: publicProcedure
    .input(z.object({ id: z.number().optional() }).optional())
    .query(async ({ input }) => {
      if (!hasDb) return null;
      const rows = input?.id
        ? await db.select().from(digests).where(eq(digests.id, input.id)).limit(1)
        : await db
            .select()
            .from(digests)
            .where(isNull(digests.deletedAt))
            .orderBy(desc(digests.createdAt))
            .limit(1);
      return rows[0] ?? null;
    }),

  /** Start generating a saved digest over a KST date range. Runs in the BACKGROUND
   *  (a full-day map-reduce outlasts the HTTP/edge timeout → "upstream error"); the
   *  client polls the digest list for the result. */
  generate: publicProcedure
    .input(
      z
        .object({
          start: z.string().optional(),
          end: z.string().optional(),
          title: z.string().optional(),
          /** Synthesize from saved digests in range instead of the feed (past dates). */
          fromDigests: z.boolean().optional(),
        })
        .optional(),
    )
    .mutation(({ input }) => {
      void generateDigest(input ?? {})
        .then((r) =>
          console.log(`[digest] manual: ${r ? `"${r.title}" (${r.itemCount} items)` : "nothing to generate"}`),
        )
        .catch((e) => console.error("[digest] manual generate failed:", e));
      return { started: true };
    }),

  /** Run the 21시 routine now for today: filter memo + digests (낮분 backfill +
   *  저녁분) + conditional whole-day sweep after primary-final success. Refused before 21시 — running early would close
   *  the 저녁분 window with a partial day (tonight's cron then skips it, and
   *  누른시각~21시 글은 어느 다이제스트에도 못 들어감) AND sweep too early. */
  runEvening: publicProcedure.mutation(async () => {
    // Diagnostic: window bounds + raw in-window count + latest analysis time.
    const today = kstToday();
    const { start, end } = kstRangeBounds(today, today);
    const [w] = hasDb
      ? await db
          .select({ n: sql<number>`count(*)` })
          .from(analyses)
          .innerJoin(articles, eq(analyses.articleId, articles.id))
          .where(
            and(
              eq(analyses.relevant, true),
              isNull(articles.deletedAt),
              gte(analyses.createdAt, start),
              lt(analyses.createdAt, end),
            ),
          )
      : [{ n: 0 }];
    const [latest] = hasDb
      ? await db.select({ createdAt: analyses.createdAt }).from(analyses).orderBy(desc(analyses.createdAt)).limit(1)
      : [{ createdAt: null }];
    const diag = {
      start: start.toISOString(),
      end: end.toISOString(),
      nowUtc: new Date().toISOString(),
      rawInWindow: Number(w?.n ?? 0),
      latestCreatedAt: latest?.createdAt ?? null,
    };
    if (kstHour() < digestHour()) {
      return {
        date: today,
        tooEarly: true,
        midday: null,
        evening: null,
        middayExisted: false,
        eveningExisted: false,
        swept: 0,
        memo: null,
        diag,
      };
    }
    // ⚠️ 경계 루틴은 앱에서 가장 무거운 작업이다 — 학습메모 distill(LLM 1회) + 낮분 보충
    // + 아침분 생성(각각 풀데이 맵리듀스) + 성공 시 하루 창 sweep. 이걸 HTTP 요청 안에서 await하면
    // 모바일 브라우저/엣지 타임아웃을 넘겨 "Load failed"로 끊긴다(2026-08 실장애).
    // `generate`와 동일하게 **즉시 반환 + 백그라운드 실행**으로 처리하고, 클라는 다이제스트
    // 목록을 폴링해 결과를 잡는다. 빠른 부분(진단 쿼리·tooEarly 판정)은 동기로 남긴다.
    void (async () => {
      try {
        const memo = await feedbackRepo.refreshGuidance();
        const run = await runDailyDigests();
        console.log(
          `[digest] 경계 루틴 완료(${today}): 낮분 ${run.midday ? `"${run.midday.title}"` : run.middayExisted ? "이미 있음" : "없음"} · ` +
            `아침분 ${run.evening ? `"${run.evening.title}"` : run.eveningExisted ? "이미 있음" : "없음"} · ` +
            `sweep ${run.swept}건${run.sweepSkippedReason ? ` (보류: ${run.sweepSkippedReason})` : ""} · ` +
            `메모 ${memo?.updated ? `갱신(신규 ${memo.newCount})` : "변화 없음"}`,
        );
      } catch (e) {
        console.error("[digest] 경계 루틴 실패:", e);
      }
    })();
    return { date: today, tooEarly: false, started: true, diag };
  }),

  /** Schedule hours (KST) + the currently-open window's date, for the UI to label
   *  runs and default the manual-digest form to "today's live window". */
  schedule: publicProcedure.query(() => ({
    middayHour: middayHour(),
    eveningHour: digestHour(),
    currentWindowDate: currentWindowDate(),
    // KST calendar day (midnight rollover) — the manual-digest form defaults here so
    // a digest is filed under the day you actually made it.
    today: kstToday(),
  })),

  /** Run the midday 작업 now: 낮분 다이제스트만 (current window's midday slot) — NEVER
   *  sweeps. Refused before that slot's split time (running early would cut the slot
   *  short and the cron would then skip it). */
  runMidday: publicProcedure.mutation(async () => {
    const date = middayLabelDate();
    if (Date.now() < slotBounds(date, "midday").end.getTime()) {
      return { date, tooEarly: true, existed: false, digest: null };
    }
    const existed = await hasMiddayFor(date);
    // 낮분도 맵리듀스라 오래 걸릴 수 있다 — runEvening과 같은 이유로 백그라운드 실행.
    if (!existed) {
      void runMiddayDigest(date)
        .then((d) => console.log(`[digest] 낮분 완료(${date}): ${d ? `"${d.title}" (${d.itemCount}건)` : "새 글 없음"}`))
        .catch((e) => console.error("[digest] 낮분 실패:", e));
    }
    return { date, tooEarly: false, existed, started: !existed };
  }),

  /** Sweep a date range's feed to trash — no digest, no feedback signal (for tidying past days). */
  sweepRange: publicProcedure
    .input(z.object({ start: z.string(), end: z.string() }))
    .mutation(async ({ input }) => {
      const swept = await sweepWindow(input.start, input.end);
      return { swept };
    }),

  /** Move a digest to trash. */
  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(digests).set({ deletedAt: new Date() }).where(eq(digests.id, input.id));
      return { ok: true };
    }),

  /** Restore from trash. */
  restore: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.update(digests).set({ deletedAt: null }).where(eq(digests.id, input.id));
      return { ok: true };
    }),

  /** Permanently delete (only from trash). */
  purge: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      if (!hasDb) throw new Error("DATABASE_URL required");
      await db.delete(digests).where(and(eq(digests.id, input.id), isNotNull(digests.deletedAt)));
      return { ok: true };
    }),

  // ── Batch ops (multi-select) ──────────────────────────────────────
  restoreMany: publicProcedure
    .input(z.object({ ids: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      if (!hasDb || input.ids.length === 0) return { ok: true };
      await db.update(digests).set({ deletedAt: null }).where(inArray(digests.id, input.ids));
      return { ok: true };
    }),
  purgeMany: publicProcedure
    .input(z.object({ ids: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      if (!hasDb || input.ids.length === 0) return { ok: true };
      await db.delete(digests).where(and(inArray(digests.id, input.ids), isNotNull(digests.deletedAt)));
      return { ok: true };
    }),
  /** Empty the digest trash. */
  purgeAll: publicProcedure.mutation(async () => {
    if (!hasDb) return { ok: true };
    await db.delete(digests).where(isNotNull(digests.deletedAt));
    return { ok: true };
  }),
});
