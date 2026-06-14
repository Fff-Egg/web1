import Parser from "rss-parser";
import type { NormalizedArticle } from "./types.js";

// Some feeds (Naver, Substack) reject the default node UA.
const BROWSER_UA = "Mozilla/5.0 (compatible; FeedWatchBot/0.1; +https://example.com/bot)";

const parser = new Parser({
  timeout: 20_000,
  headers: { "User-Agent": BROWSER_UA },
});

export interface FetchRssOpts {
  maxItems?: number;
  /** If the URL isn't a feed (e.g. a homepage was pasted), try to discover the
   *  site's feed via its HTML <link rel="alternate"> tag. Used by generic_rss. */
  autodiscover?: boolean;
}

/** Remember a page→feed resolution so we don't re-scrape the HTML every cycle. */
const feedUrlCache = new Map<string, string>();

/**
 * Pull the feed URL a page advertises via standard autodiscovery:
 *   <link rel="alternate" type="application/rss+xml" href="…">  (atom+xml too)
 * Emitted by WordPress, Ghost, Tistory, Substack, Hugo, Jekyll … — so pasting the
 * homepage usually "just works". Returns an absolute URL or null.
 */
async function discoverFeedUrl(pageUrl: string): Promise<string | null> {
  const cached = feedUrlCache.get(pageUrl);
  if (cached) return cached;

  const res = await fetch(pageUrl, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']?application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(href, pageUrl).toString();
      feedUrlCache.set(pageUrl, abs);
      return abs;
    } catch {
      /* malformed href — keep scanning */
    }
  }
  return null;
}

/** Parse a feed URL; with autodiscover, recover when a homepage (HTML) was given. */
async function loadFeed(
  feedUrl: string,
  autodiscover: boolean,
): Promise<Awaited<ReturnType<typeof parser.parseURL>>> {
  try {
    return await parser.parseURL(feedUrl);
  } catch (err) {
    if (autodiscover) {
      const real = await discoverFeedUrl(feedUrl).catch(() => null);
      if (real && real !== feedUrl) return parser.parseURL(real);
      throw new Error(
        "RSS 피드를 찾지 못했습니다. 입력한 주소가 RSS가 아니라 웹페이지(HTML)일 수 있어요. " +
          "사이트의 피드 주소를 직접 넣어보세요 (예: …/feed/, …/rss, …/rss.xml). " +
          `(원인: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw err;
  }
}

/**
 * Core RSS fetch + normalize, shared by every rss-based provider
 * (generic_rss, naver_blog, hankyung, substack-rss …).
 */
export async function fetchRss(
  feedUrl: string,
  opts: FetchRssOpts = {},
): Promise<NormalizedArticle[]> {
  const feed = await loadFeed(feedUrl, !!opts.autodiscover);
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
