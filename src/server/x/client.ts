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
  // The library calls api.x.com / x.com, so cookies MUST be on the .x.com domain
  // (browser stores them there too) — otherwise the jar omits them → 401, and
  // ct0 (the x-csrf-token source) is missing. Set .twitter.com too for safety.
  const pair = (domain: string) => [
    `auth_token=${authToken}; Domain=${domain}; Path=/; Secure; HttpOnly`,
    `ct0=${ct0}; Domain=${domain}; Path=/; Secure`,
  ];
  await scraper.setCookies([...pair(".x.com"), ...pair(".twitter.com")]);
  _scraper = scraper;
  return scraper;
}
