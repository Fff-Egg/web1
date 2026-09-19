import { AsyncLocalStorage } from "node:async_hooks";

export type DigestProgress = (message: string, digestId?: number) => Promise<void>;
const progress = new AsyncLocalStorage<DigestProgress>();
export const withDigestProgress = <T>(report: DigestProgress, work: () => Promise<T>): Promise<T> => progress.run(report, work);
export async function reportDigestProgress(message: string, digestId?: number): Promise<void> {
  await progress.getStore()?.(message, digestId);
}
