import Parser from "rss-parser";
import type { NormalizedArticle } from "./types.js";

const parser = new Parser({
  timeout: 20_000,
  headers: {
    // Some feeds (Naver, Substack) reject the default node UA
    "User-Agent":
      "Mozilla/5.0 (compatible; FeedWatchBot/0.1; +https://example.com/bot)",
  },
});

/**
 * Core RSS fetch + normalize, shared by every rss-based provider
 * (generic_rss, naver_blog, hankyung, substack-rss …).
 */
export async function fetchRss(
  feedUrl: string,
  opts: { maxItems?: number } = {},
): Promise<NormalizedArticle[]> {
  const feed = await parser.parseURL(feedUrl);
  const items = feed.items ?? [];
  const limited = opts.maxItems ? items.slice(0, opts.maxItems) : items;

  return limited.map((item) => {
    // Prefer a stable provider id; fall back to link, then a title hash.
    const externalId =
      item.guid ?? item.link ?? hashString(item.title ?? JSON.stringify(item));

    // content:encoded (full) > content > contentSnippet (preview)
    const body =
      (item as Record<string, unknown>)["content:encoded"] as string | undefined ??
      item.content ??
      item.contentSnippet ??
      null;

    return {
      externalId,
      url: item.link ?? null,
      title: item.title ?? null,
      body: body ?? null,
      author: item.creator ?? (item as Record<string, unknown>).author as string ?? null,
      publishedAt: item.isoDate ? new Date(item.isoDate) : null,
    } satisfies NormalizedArticle;
  });
}

/** Detect a truncated (paywalled) body so auth adapters know to fetch full text. */
export function looksTruncated(body: string | null | undefined): boolean {
  if (!body) return true;
  const text = body.replace(/<[^>]+>/g, "").trim();
  return text.length < 280;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}
