const KST_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** DeepSeek's twice-priced windows, converted from Beijing time to KST. */
export const ANALYSIS_PEAK_WINDOWS_KST = [
  { startMinute: 10 * 60, endMinute: 13 * 60 },
  { startMinute: 15 * 60, endMinute: 19 * 60 },
] as const;

export function kstMinuteOfDay(at = new Date()): number {
  const parts = KST_CLOCK.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function isAutomaticAnalysisPeakAvoidanceEnabled(): boolean {
  return process.env.ANALYSIS_AVOID_PEAK !== "0";
}

/**
 * Collection always continues. Only the automatic per-article LLM analysis is
 * deferred during peak pricing. Set ANALYSIS_AVOID_PEAK=0 as a kill switch.
 */
export function shouldDeferAutomaticAnalysis(at = new Date()): boolean {
  if (!isAutomaticAnalysisPeakAvoidanceEnabled()) return false;
  const minute = kstMinuteOfDay(at);
  return ANALYSIS_PEAK_WINDOWS_KST.some(
    ({ startMinute, endMinute }) => minute >= startMinute && minute < endMinute,
  );
}
