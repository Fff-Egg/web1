import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss, looksTruncated } from "./rss.js";
import { hasSession } from "../auth/session.js";
import { fetchWithSession } from "../auth/browser.js";

/**
 * Build the publication feed URL from a handle or URL.
 *   "foo"                -> https://foo.substack.com/feed
 *   "foo.substack.com"   -> https://foo.substack.com/feed
 *   "https://foo.substack.com" / custom domain -> <origin>/feed
 */
export function substackFeedUrl(identifier: string, override?: string): string {
  if (override) return override;
  let id = identifier.trim().replace(/\/+$/, "");

  if (/^https?:\/\//i.test(id)) {
    const u = new URL(id);
    return `${u.origin}/feed`;
  }
  if (!id.includes(".")) id = `${id}.substack.com`;
  return `https://${id}/feed`;
}

const MAX_ENRICH = 8; // cap paid-body fetches per pass (browser calls are slow)

/**
 * substack — RSS for the post list/preview; when a login session exists, paid
 * (truncated) posts get their full body pulled with the saved session.
 */
export const substackAdapter: SourceAdapter = {
  provider: "substack",
  label: "Substack",
  requiresAuth: false, // RSS works without auth; session only enriches paid posts
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const feedUrl = substackFeedUrl(source.identifier, source.config?.rssUrl);
    const items = await fetchRss(feedUrl, { maxItems: source.config?.maxItems ?? 30 });

    if (!hasSession(source.id)) return items;

    // Enrich the newest truncated posts with full text via the session.
    let enriched = 0;
    for (const item of items) {
      if (enriched >= MAX_ENRICH) break;
      if (!item.url || !looksTruncated(item.body)) continue;
      try {
        const full = await fetchWithSession({
          sourceId: source.id,
          url: item.url,
          bodySelector: source.config?.bodySelector ?? ".body, article",
          loginUrlHints: ["sign-in", "subscribe"],
        });
        if (full && full.length > (item.body?.length ?? 0)) item.body = full;
        enriched++;
      } catch {
        // leave the RSS preview; worker handles session errors elsewhere
        break;
      }
    }
    return items;
  },
};
