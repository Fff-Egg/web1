import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";

/**
 * Resolve a Hankyung feed URL. If the identifier already looks like a feed
 * (.xml or /feed/...), use it as-is; if it's the bare homepage, fall back to
 * the economy section feed.
 */
export function hankyungFeedUrl(identifier: string, override?: string): string {
  if (override) return override;
  const id = identifier.trim();
  if (/\.xml(\?|$)/i.test(id) || /\/feed\//i.test(id)) return id;
  // bare homepage or section page → default to economy feed
  return "https://www.hankyung.com/feed/economy";
}

/**
 * hankyung — public articles via section RSS. Premium articles are excluded
 * (RSS only exposes public items). Full-text scrape enrichment can come later.
 */
export const hankyungAdapter: SourceAdapter = {
  provider: "hankyung",
  label: "한국경제",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const feedUrl = hankyungFeedUrl(source.identifier, source.config?.rssUrl);
    return fetchRss(feedUrl, { maxItems: source.config?.maxItems ?? 30 });
  },
};
