import { digestHour, middayHour } from "./digest/digest.js";
import { ANALYSIS_PEAK_WINDOWS_KST, isAutomaticAnalysisPeakAvoidanceEnabled, shouldDeferAutomaticAnalysis } from "./analysis/schedule.js";
import type { RuntimeSchedule } from "../shared/runtimeSchedule.js";

/** Report the same runtime settings the scheduler consumes; never edit them. */
export function getRuntimeSchedule(now = new Date()): RuntimeSchedule {
  return {
    timezone: "Asia/Seoul",
    automaticEnabled: process.env.DISABLE_SCHEDULERS !== "1",
    digestHour: digestHour(), middayHour: middayHour(),
    digestHourSource: process.env.DIGEST_HOUR !== undefined ? "railway" : "default",
    middayHourSource: process.env.DIGEST_MIDDAY_HOUR !== undefined ? "railway" : "default",
    peakAvoidanceEnabled: isAutomaticAnalysisPeakAvoidanceEnabled(),
    analysisDeferred: shouldDeferAutomaticAnalysis(now),
    pauseWindows: ANALYSIS_PEAK_WINDOWS_KST.map(window => ({ ...window })),
    resumeHours: [13, 19], checkedAt: now.toISOString(),
  };
}
