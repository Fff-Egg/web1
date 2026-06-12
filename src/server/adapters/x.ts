import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";
import { getXScraper, hasXSession } from "../x/client.js";

function handle(identifier: string): string {
  return identifier.trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "").replace(/\/.*$/, "");
}

/** Tweets have no title — use the first line of the text, clipped. */
function tweetTitle(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim()) ?? text;
  return firstLine.length > 90 ? firstLine.slice(0, 90) + "…" : firstLine;
}

/**
 * Direct timeline fetch via the user's X account cookies (X_AUTH_TOKEN/X_CT0) —
 * no browser, no bridge. Dedup relies on the stable tweet id as externalId.
 */
async function fetchDirect(h: string, maxItems: number): Promise<NormalizedArticle[]> {
  const scraper = await getXScraper();
  const out: NormalizedArticle[] = [];
  try {
    for await (const t of scraper.getTweets(h, maxItems)) {
      const text = t.text?.trim();
      if (!t.id || !text) continue; // media-only or malformed entries
      out.push({
        externalId: t.id,
        url: t.permanentUrl ?? `https://x.com/${h}/status/${t.id}`,
        title: (t.isRetweet ? "RT " : "") + tweetTitle(text),
        body: text,
        author: `@${t.username ?? h}`,
        publishedAt: t.timeParsed ?? (t.timestamp ? new Date(t.timestamp * 1000) : null),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`X 직접 수집 실패(@${h}) — 쿠키 만료/차단 가능성: ${msg}`);
  }
  return out;
}

/**
 * Resolve the public RSS feed URL for an X handle. No login required — X public
 * posts are pulled through an RSS bridge (Nitter / RSSHub / RSS.app …):
 *
 *  - Per-source override: set `config.rssUrl` to a ready-made feed URL
 *    (e.g. an RSS.app feed) and it's used as-is.
 *  - Global template: set env `X_RSS_BRIDGE` to a bridge template. Either use a
 *    `{handle}` placeholder (e.g. "https://nitter.example/{handle}/rss") or a
 *    base URL ("https://nitter.example") and we append "/{handle}/rss".
 */
function feedUrlFor(source: Source): string {
  const direct = source.config?.rssUrl;
  if (direct) return direct;

  const bridge = process.env.X_RSS_BRIDGE?.trim();
  if (!bridge) {
    throw new Error(
      "X 수집 설정 필요 — X_AUTH_TOKEN/X_CT0(직접 수집, 권장) 또는 X_RSS_BRIDGE/소스 rssUrl(브리지)을 설정하세요.",
    );
  }
  const h = handle(source.identifier);
  return bridge.includes("{handle}")
    ? bridge.replace("{handle}", h)
    : `${bridge.replace(/\/+$/, "")}/${h}/rss`;
}

/**
 * x — public posts from a handle. Preferred path: direct fetch with the user's
 * own X cookies (X_AUTH_TOKEN/X_CT0; no browser needed). Fallback: an RSS
 * bridge (config.rssUrl per source, or the X_RSS_BRIDGE template).
 */
export const xAdapter: SourceAdapter = {
  provider: "x",
  label: "X (Twitter)",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const h = handle(source.identifier);
    const maxItems = source.config?.maxItems ?? 30;
    if (hasXSession()) return fetchDirect(h, maxItems);
    const items = await fetchRss(feedUrlFor(source), { maxItems });
    // Bridge feeds often omit an author; stamp the handle so the Feed/Manual UI
    // groups and labels them clearly.
    return items.map((it) => ({ ...it, author: it.author ?? `@${h}` }));
  },
};
