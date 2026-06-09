import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { fetchRss } from "./rss.js";

function handle(identifier: string): string {
  return identifier.trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "").replace(/\/.*$/, "");
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
      "X 공개 수집에는 RSS 브리지가 필요합니다. 환경변수 X_RSS_BRIDGE 를 설정하거나, " +
        "이 소스의 rssUrl 에 RSS 주소(예: RSS.app 피드)를 직접 넣으세요.",
    );
  }
  const h = handle(source.identifier);
  return bridge.includes("{handle}")
    ? bridge.replace("{handle}", h)
    : `${bridge.replace(/\/+$/, "")}/${h}/rss`;
}

/**
 * x — public posts from a handle, no login. Reads through an RSS bridge so the
 * server never needs a logged-in browser session. (Member-only / protected
 * accounts are out of scope by design.)
 */
export const xAdapter: SourceAdapter = {
  provider: "x",
  label: "X (Twitter)",
  requiresAuth: false,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const h = handle(source.identifier);
    const items = await fetchRss(feedUrlFor(source), { maxItems: source.config?.maxItems ?? 30 });
    // Bridge feeds often omit an author; stamp the handle so the Feed/Manual UI
    // groups and labels them clearly.
    return items.map((it) => ({ ...it, author: it.author ?? `@${h}` }));
  },
};
