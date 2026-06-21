import { router, publicProcedure } from "../trpc.js";
import { sourcesRouter } from "./sources.js";
import { settingsRouter } from "./settings.js";
import { feedRouter } from "./feed.js";
import { digestRouter } from "./digest.js";
import { manualRouter } from "./manual.js";
import { marketRouter } from "./market.js";
import { researchRouter } from "./research.js";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, ts: Date.now() })),
  sources: sourcesRouter,
  settings: settingsRouter,
  feed: feedRouter,
  digest: digestRouter,
  manual: manualRouter,
  market: marketRouter,
  research: researchRouter,
});

export type AppRouter = typeof appRouter;
