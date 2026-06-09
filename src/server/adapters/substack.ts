import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";

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

/**
 * substack — Phase 2 covers the RSS path: post list, URL, and preview body.
 * Paywalled full text via stored session is added in Phase 5; the truncation
 * detector in rss.ts already flags which bodies need enrichment.
 */
export const substackAdapter: SourceAdapter = {
  provider: "substack",
  label: "Substack",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const feedUrl = substackFeedUrl(source.identifier, source.config?.rssUrl);
    return fetchRss(feedUrl, { maxItems: source.config?.maxItems ?? 30 });
  },
};
