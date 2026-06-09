import { router, publicProcedure } from "../trpc.js";
import { sourcesRouter } from "./sources.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  sources: sourcesRouter,
});

export type AppRouter = typeof appRouter;
