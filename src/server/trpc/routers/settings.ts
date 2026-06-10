import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { settingsRepo } from "../../repo/settings.js";

const analysisConfigSchema = z.object({
  instructions: z.string(),
  relevanceCriteria: z.string().optional(),
  importanceCriteria: z.string().optional(),
  summaryInstructions: z.string().optional(),
  digestInstructions: z.string().optional(),
  filterModel: z.string().optional(),
  analysisModel: z.string().optional(),
});

/** settings router — edit the analysis instructions ("지침") from the dashboard. */
export const settingsRouter = router({
  getAnalysisConfig: publicProcedure.query(() => settingsRepo.getAnalysisConfig()),
  updateAnalysisConfig: publicProcedure
    .input(analysisConfigSchema)
    .mutation(async ({ input }) => {
      await settingsRepo.setAnalysisConfig(input);
      return { ok: true };
    }),
});
