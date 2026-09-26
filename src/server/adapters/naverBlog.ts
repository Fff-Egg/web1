import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";

/** Extract the blog id from a full URL or a bare handle. */
export function naverBlogId(identifier: string): string {
  const trimmed = identifier.trim();
  // blog.naver.com/{id} or https://blog.naver.com/{id}
  const m = trimmed.match(/blog\.naver\.com\/([^/?#]+)/i);
  if (m) return m[1];
  return trimmed.replace(/^@/, "");
}

/**
 * naver_blog — public posts via the official RSS endpoint.
 * Body may be short; full-text scraping enrichment is optional/later.
 */
export const naverBlogAdapter: SourceAdapter = {
  provider: "naver_blog",
  label: "네이버 블로그",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const id = naverBlogId(source.identifier);
    const feedUrl = source.config?.rssUrl ?? `https://rss.blog.naver.com/${id}.xml`;
    return fetchRss(feedUrl, { maxItems: source.config?.maxItems ?? 30 });
  },
};
