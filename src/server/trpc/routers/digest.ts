import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lt, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { digests, analyses, articles } from "../../db/schema.js";
import {
  kstToday,
  kstHour,
  kstRangeBounds,
  sweepWindow,
  runMiddayDigest,
  hasMiddayFor,
  middayHour,
  middayLabelDate,
  digestHour,
  currentWindowDate,
  slotBounds,
} from "../../digest/digest.js";
import { boundaryRunner, startBoundaryRun } from "../../digest/boundaryRun.js";
import { manualDigestRunner } from "../../digest/manualRun.js";

const digestDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}, "올바른 날짜를 선택하세요.");

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
   *  client polls this exact job for progress, empty input, errors, and its saved ID. */
  generate: publicProcedure
    .input(
      z
        .object({
          start: digestDate.optional(),
          end: digestDate.optional(),
          title: z.string().optional(),
          /** Synthesize from saved digests in range instead of the feed (past dates). */
          fromDigests: z.boolean().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const start = input?.start ?? kstToday();
      const end = input?.end ?? start;
      if (end < start) throw new TRPCError({ code: "BAD_REQUEST", message: "종료일은 시작일보다 빠를 수 없습니다." });
      const { job, reused } = await manualDigestRunner.start({ start, end, title: input?.title?.trim() || undefined, fromDigests: !!input?.fromDigests });
      return { started: true, job, reused };
    }),

  manualStatus: publicProcedure.query(() => manualDigestRunner.status()),

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
    const { job, reused } = await startBoundaryRun(today);
    return { date: today, tooEarly: false, started: true, job, reused, diag };
  }),

  boundaryStatus: publicProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional())
    .query(({ input }) => boundaryRunner.status(input?.date ?? kstToday())),

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
