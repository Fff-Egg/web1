import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { AnalysisConfig } from "../db/schema.js";
import { DEFAULT_ANALYSIS_CONFIG } from "../../shared/analysis.js";

const ANALYSIS_KEY = "analysis";

export interface SettingsRepo {
  getAnalysisConfig(): Promise<AnalysisConfig>;
  setAnalysisConfig(cfg: AnalysisConfig): Promise<void>;
}

const mysqlRepo: SettingsRepo = {
  async getAnalysisConfig() {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ANALYSIS_KEY))
      .limit(1);
    if (rows.length === 0) return { ...DEFAULT_ANALYSIS_CONFIG };
    return { ...DEFAULT_ANALYSIS_CONFIG, ...(rows[0].value as unknown as AnalysisConfig) };
  },
  async setAnalysisConfig(cfg) {
    const value = cfg as unknown as Record<string, unknown>;
    await db
      .insert(settings)
      .values({ key: ANALYSIS_KEY, value })
      .onDuplicateKeyUpdate({ set: { value } });
  },
};

function makeMemoryRepo(): SettingsRepo {
  let cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG };
  return {
    async getAnalysisConfig() {
      return { ...cfg };
    },
    async setAnalysisConfig(next) {
      cfg = { ...next };
    },
  };
}

export const settingsRepo: SettingsRepo = hasDb ? mysqlRepo : makeMemoryRepo();
