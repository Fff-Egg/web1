import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";

/**
 * generic_rss — the identifier is the RSS URL itself. Also the base building
 * block other rss providers (naver_blog, hankyung, substack) delegate to.
 */
export const genericRssAdapter: SourceAdapter = {
  provider: "generic_rss",
  label: "Generic RSS",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const feedUrl = source.config?.rssUrl ?? source.identifier;
    if (!feedUrl) throw new Error(`Source ${source.id} has no RSS URL`);
    return fetchRss(feedUrl, { maxItems: source.config?.maxItems ?? 50 });
  },
};
