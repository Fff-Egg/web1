export interface ManualDigestRequest {
  start: string;
  end: string;
  title?: string;
  fromDigests: boolean;
}

export interface DigestSourceCounts {
  source: "feed" | "digests" | "none";
  /** null when feed lookup was explicitly skipped. */
  feedEligible: number | null;
  /** null when saved-report lookup was unnecessary. */
  savedDigests: number | null;
  excluded?: { review: number; sourceReview: number; trashed: number };
  /** Global backlog, not the selected date range (dates use analysis completion). */
  pendingAnalysis?: number;
  automaticAnalysisDeferred?: boolean;
  analysisResumeHour?: number;
  llmConfigured: boolean;
}

/** The latest manual generation, persisted separately from the scheduled jobs. */
export interface ManualDigestRun {
  id: string;
  request: ManualDigestRequest;
  state: "running" | "succeeded" | "empty" | "failed" | "interrupted";
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  digestId?: number;
  sources?: DigestSourceCounts;
}
