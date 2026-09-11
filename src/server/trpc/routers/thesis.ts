import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { thesisRepo } from "../../repo/thesis.js";

/**
 * thesis router — 논지 지도(Thesis Map). Threads (user theses) with
 * system-aggregated signal stats, plus the inbox of unassigned new-thesis
 * candidates. Signals themselves are written by the analyzer (no LLM call here).
 */
export const thesisRouter = router({
  /** Threads + 7/30-day verdict aggregates. */
  threads: publicProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(({ input }) => thesisRepo.listWithStats(input?.includeArchived ?? false)),

  createThread: publicProcedure
    .input(
      z.object({
        code: z.string().max(16).optional(),
        name: z.string().min(1).max(255),
        thesis: z.string().max(512).optional(),
        context: z.string().optional(),
      }),
    )
    .mutation(({ input }) => thesisRepo.createThread(input)),

  updateThread: publicProcedure
    .input(
      z.object({
        id: z.number(),
        code: z.string().max(16).nullable().optional(),
        name: z.string().min(1).max(255).optional(),
        thesis: z.string().max(512).nullable().optional(),
        context: z.string().nullable().optional(),
        sort: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await thesisRepo.updateThread(input);
      return { ok: true };
    }),

  setArchived: publicProcedure
    .input(z.object({ id: z.number(), archived: z.boolean() }))
    .mutation(async ({ input }) => {
      await thesisRepo.setArchived(input.id, input.archived);
      return { ok: true };
    }),

  removeThread: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await thesisRepo.removeThread(input.id);
      return { ok: true };
    }),

  /** Signals attached to one thread (with article info). */
  signals: publicProcedure
    .input(z.object({ threadId: z.number(), limit: z.number().min(1).max(500).default(200) }))
    .query(({ input }) => thesisRepo.threadSignals(input.threadId, input.limit)),

  /** Inbox of unassigned new-thesis candidates. */
  inbox: publicProcedure.query(() => thesisRepo.inbox()),

  assignSignal: publicProcedure
    .input(z.object({ signalId: z.number(), threadId: z.number() }))
    .mutation(async ({ input }) => {
      await thesisRepo.assignSignal(input.signalId, input.threadId);
      return { ok: true };
    }),

  promoteSignal: publicProcedure
    .input(z.object({ signalId: z.number(), name: z.string().max(255).optional(), thesis: z.string().max(512).optional() }))
    .mutation(({ input }) =>
      thesisRepo.promoteSignal(input.signalId, { name: input.name, thesis: input.thesis }),
    ),

  dismissSignal: publicProcedure
    .input(z.object({ signalId: z.number() }))
    .mutation(async ({ input }) => {
      await thesisRepo.dismissSignal(input.signalId);
      return { ok: true };
    }),

  /** Seed A~E starter threads (only when none exist). */
  seed: publicProcedure.mutation(() => thesisRepo.seedDefaults()),
});
