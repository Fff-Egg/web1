/** Status of the daily boundary task, shared by the scheduler and its manual button. */
export interface BoundaryRun {
  id: string;
  date: string;
  state: "running" | "succeeded" | "failed" | "interrupted";
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  warnings: string[];
  digestIds: number[];
  result?: {
    midday: "created" | "existing" | "empty";
    morning: "created" | "existing" | "empty";
    swept: number;
    sweepSkippedReason: string | null;
  };
}
