import type { DigestSourceCounts } from "../../shared/manualDigestRun.js";

/** Resolve inputs before preparing articles or calling the LLM. No new sources
 * are invented when the requested window has no eligible inputs. */
export async function resolveDigestSources<F, D>(
  opts: { fromDigests?: boolean; auto?: boolean; llmConfigured: boolean },
  deps: {
    feed(): Promise<F[]>;
    digests(): Promise<D[]>;
    emptyFeedDiagnostics(): Promise<Pick<DigestSourceCounts,
      "excluded" | "pendingAnalysis" | "automaticAnalysisDeferred" | "analysisResumeHour">>;
  },
): Promise<{ feed: F[]; digests: D[]; counts: DigestSourceCounts }> {
  const feed = opts.fromDigests ? [] : await deps.feed();
  const useDigests = !!opts.fromDigests || (feed.length === 0 && !opts.auto);
  const digests = useDigests ? await deps.digests() : [];
  const counts: DigestSourceCounts = {
    source: feed.length ? "feed" : digests.length ? "digests" : "none",
    feedEligible: opts.fromDigests ? null : feed.length,
    savedDigests: useDigests ? digests.length : null,
    llmConfigured: opts.llmConfigured,
  };
  // Diagnostics only for manual empty-feed requests. Scheduled runs keep their
  // existing workload, and explicit saved-report requests never inspect feeds.
  if (!opts.auto && !opts.fromDigests && feed.length === 0) {
    Object.assign(counts, await deps.emptyFeedDiagnostics());
  }
  return { feed, digests, counts };
}
