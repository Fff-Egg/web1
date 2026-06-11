import { z } from "zod";
import { and, desc, eq, isNull, isNotNull, inArray } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { digests } from "../../db/schema.js";
import { generateDigest, kstToday } from "../../digest/digest.js";
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

  /** Generate a new saved digest over a KST date range. */
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
    .mutation(async ({ input }) => generateDigest(input ?? {})),

  /** Run the 21시 routine now for today (filter memo + auto-digest + that window's sweep). */
  runEvening: publicProcedure.mutation(async () => {
    await feedbackRepo.refreshGuidance();
    const digest = await generateDigest({ auto: true, trashFeedAfter: true });
    return { date: kstToday(), digest };
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
