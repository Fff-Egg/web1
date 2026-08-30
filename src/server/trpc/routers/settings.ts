import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { settingsRepo } from "../../repo/settings.js";
import {
  ANALYSIS_MODEL,
  FILTER_MODEL,
  llmProvider,
  resolveModel,
} from "../../analysis/anthropic.js";
import {
  digestFinalTokenBudget,
  DIGEST_PRO_THINKING_TOKEN_FLOOR,
} from "../../digest/modelPipeline.js";

const analysisConfigSchema = z.object({
  instructions: z.string(),
  relevanceCriteria: z.string().optional(),
  importanceCriteria: z.string().optional(),
  summaryInstructions: z.string().optional(),
  digestInstructions: z.string().optional(),
  filterModel: z.string().optional(),
  digestMapModel: z.string().optional(),
  analysisModel: z.string().optional(),
});

type ModelSource = "web" | "railway" | "default" | "filter";

function configuredModel(
  web: string | undefined,
  envName: "FILTER_MODEL" | "ANALYSIS_MODEL",
  fallback: () => string,
): { configured: string; effective: string; source: ModelSource } {
  const saved = web?.trim();
  const env = process.env[envName]?.trim();
  const configured = saved || env || fallback();
  return {
    configured,
    effective: resolveModel(configured),
    source: saved ? "web" : env ? "railway" : "default",
  };
}

/** settings router — edit the analysis instructions ("지침") from the dashboard. */
export const settingsRouter = router({
  getAnalysisConfig: publicProcedure.query(() => settingsRepo.getAnalysisConfig()),
  /** Non-secret, effective model plan after Settings/env/provider remapping. */
  getModelPlan: publicProcedure.query(async () => {
    const cfg = await settingsRepo.getAnalysisConfig();
    const filter = configuredModel(cfg.filterModel, "FILTER_MODEL", FILTER_MODEL);
    const mapSaved = cfg.digestMapModel?.trim();
    const map = mapSaved
      ? { configured: mapSaved, effective: resolveModel(mapSaved), source: "web" as const }
      : { ...filter, source: "filter" as const };
    const final = configuredModel(cfg.analysisModel, "ANALYSIS_MODEL", ANALYSIS_MODEL);
    const fallbackTokens = Number(process.env.DIGEST_MAX_TOKENS ?? 8192);
    const configuredProTokens = Number(
      process.env.DIGEST_PRO_THINKING_TOKENS ?? DIGEST_PRO_THINKING_TOKEN_FLOOR,
    );
    const finalTokens = digestFinalTokenBudget(final.effective, fallbackTokens, configuredProTokens);
    return {
      provider: llmProvider(),
      filter,
      map,
      final,
      finalTokens,
      finalAttempts: 1,
      finalFallbackTokens: fallbackTokens,
    };
  }),
  updateAnalysisConfig: publicProcedure
    .input(analysisConfigSchema)
    .mutation(async ({ input }) => {
      await settingsRepo.setAnalysisConfig(input);
      return { ok: true };
    }),

  /** The cumulative "learned memo" (auto-distilled from feedback; separate from importanceCriteria). */
  getFilterGuidance: publicProcedure.query(() => settingsRepo.getFilterGuidance()),
  /** Manually edit / clear the learned memo. Preserves the feedback cursor & count. */
  setFilterGuidance: publicProcedure
    .input(z.object({ text: z.string() }))
    .mutation(async ({ input }) => {
      const prev = await settingsRepo.getFilterGuidance();
      await settingsRepo.setFilterGuidance({ ...prev, text: input.text, updatedAt: new Date().toISOString() });
      return { ok: true };
    }),
});
