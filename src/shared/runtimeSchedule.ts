export interface RuntimeSchedule {
  timezone: "Asia/Seoul";
  automaticEnabled: boolean;
  digestHour: number;
  middayHour: number;
  digestHourSource: "railway" | "default";
  middayHourSource: "railway" | "default";
  peakAvoidanceEnabled: boolean;
  analysisDeferred: boolean;
  pauseWindows: { startMinute: number; endMinute: number }[];
  resumeHours: number[];
  checkedAt: string;
}
