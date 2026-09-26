export type AnalysisRetryReason = "output_limit" | "reading_held" | "request_rejected" | "authentication" | "balance" | "rate_limit" | "transient";
export interface AnalysisRetryPause { reason: AnalysisRetryReason; until: string }
export interface AnalysisRetryStatus {
  persisted: boolean;
  totalPending: number;
  eligible: number;
  held: number;
  waiting: number;
  globalPause: AnalysisRetryPause | null;
  items: { articleId: number; title: string | null; reason: AnalysisRetryReason; attempts: number; held: boolean; nextRetryAt: string | null; updatedAt: string }[];
}
