import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, hasDb } from "../../db/client.js";
import { digests } from "../../db/schema.js";
import { generateDigest } from "../../digest/digest.js";

/** digest router — list available dates, fetch one, or generate on demand. */
export const digestRouter = router({
  /** Available digest dates (newest first). */
  dates: publicProcedure.query(async () => {
    if (!hasDb) return [];
    return db
      .select({ date: digests.date, createdAt: digests.createdAt })
      .from(digests)
      .orderBy(desc(digests.date));
  }),

  /** A single digest by date (YYYY-MM-DD), or the latest if omitted. */
  get: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => {
      if (!hasDb) return null;
      const q = db.select().from(digests);
      const rows = input?.date
        ? await q.where(eq(digests.date, input.date)).limit(1)
        : await q.orderBy(desc(digests.date)).limit(1);
      return rows[0] ?? null;
    }),

  /** Manually (re)generate a digest for a date (defaults to today KST). */
  generate: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      return generateDigest(input?.date);
    }),
});
