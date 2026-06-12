import { Scraper } from "@the-convocation/twitter-scraper";

/**
 * Direct X (Twitter) access using the user's own account cookies — no browser,
 * no RSS bridge. Mirrors the telegram MTProto pattern: credentials live in env
 * and a lazy singleton client is shared across fetches.
 *
 * Setup: log into x.com in a browser, copy two cookies from devtools
 * (Application → Cookies → https://x.com):
 *   X_AUTH_TOKEN = value of `auth_token` (HttpOnly)
 *   X_CT0        = value of `ct0`
 * Cookies last months; if collection starts failing with auth errors, refresh them.
 */
export function hasXSession(): boolean {
  return Boolean(process.env.X_AUTH_TOKEN && process.env.X_CT0);
}

let _scraper: Scraper | null = null;

export async function getXScraper(): Promise<Scraper> {
  if (_scraper) return _scraper;
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken || !ct0) {
    throw new Error("X 세션 미설정 — X_AUTH_TOKEN / X_CT0 환경변수가 필요합니다.");
  }
  const scraper = new Scraper();
  // The internal API authenticates against twitter.com hosts; ct0 doubles as the
  // CSRF token, so both cookies must be present.
  await scraper.setCookies([
    `auth_token=${authToken}; Domain=.twitter.com; Path=/; Secure; HttpOnly; SameSite=None`,
    `ct0=${ct0}; Domain=.twitter.com; Path=/; Secure; SameSite=Lax`,
  ]);
  _scraper = scraper;
  return scraper;
}
