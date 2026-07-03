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
   *  저녁분) + whole-day sweep. Refused before 21시 — running early would close
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
    const memo = await feedbackRepo.refreshGuidance();
    const run = await runDailyDigests();
    return {
      date: today,
      tooEarly: false,
      midday: run.midday,
      evening: run.evening,
      middayExisted: run.middayExisted,
      eveningExisted: run.eveningExisted,
      swept: run.swept,
      memo,
      diag,
    };
  }),

  /** Schedule hours (KST) + the currently-open window's date, for the UI to label
   *  runs and default the manual-digest form to "today's live window". */
  schedule: publicProcedure.query(() => ({
    middayHour: middayHour(),
    eveningHour: digestHour(),
    currentWindowDate: currentWindowDate(),
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
    const digest = existed ? null : await runMiddayDigest(date);
    return { date, tooEarly: false, existed, digest };
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
