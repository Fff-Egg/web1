import { AsyncLocalStorage } from "node:async_hooks";
import type { DigestSourceCounts } from "../../shared/manualDigestRun.js";

export type DigestProgress = (message: string, digestId?: number) => Promise<void>;
type SourceReporter = (sources: DigestSourceCounts) => Promise<void>;
const progress = new AsyncLocalStorage<{ report: DigestProgress; sources?: SourceReporter }>();
export const withDigestProgress = <T>(report: DigestProgress, work: () => Promise<T>, sources?: SourceReporter): Promise<T> =>
  progress.run({ report, sources }, work);
export async function reportDigestProgress(message: string, digestId?: number): Promise<void> {
  await progress.getStore()?.report(message, digestId);
}
export async function reportDigestSources(sources: DigestSourceCounts): Promise<void> {
  await progress.getStore()?.sources?.(sources);
}
