export type AnalysisRetryReason = "output_limit" | "reading_held" | "request_rejected" | "authentication" | "balance" | "rate_limit" | "overloaded" | "transient";
export interface AnalysisRetryPause { reason: AnalysisRetryReason; until: string }
/** Read-only preview: unanalyzed articles collected before / from KST 00:00 of `date`. */
export interface BacklogCleanupPreview { date: string; cutoff: string; before: number; kept: number }
/** Last "밀린 미분석 글 정리": unanalyzed articles collected before `cutoff` moved to trash at `at`. */
export interface BacklogCleanup { date: string; cutoff: string; at: string; trashed: number }
export interface AnalysisRetryStatus {
  persisted: boolean;
  totalPending: number;
  eligible: number;
  held: number;
  waiting: number;
  globalPause: AnalysisRetryPause | null;
  items: { articleId: number; title: string | null; reason: AnalysisRetryReason; attempts: number; held: boolean; nextRetryAt: string | null; updatedAt: string }[];
}
