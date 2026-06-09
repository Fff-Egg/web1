import type { Source } from "../db/schema.js";
import type { SourceAdapter, NormalizedArticle } from "./types.js";
import { extractItemsWithSession } from "../auth/browser.js";

function handle(identifier: string): string {
  return identifier.trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "");
}

/**
 * x — posts from a handle.
 *  - If X_API_PROVIDER is set, use the API path (recommended; lower ban risk).
 *  - Otherwise fall back to session scraping of the profile page.
 *
 * ⚠ Automated login/scraping of a main X account risks suspension. Prefer the
 * API path; the session path is best-effort.
 */
export const xAdapter: SourceAdapter = {
  provider: "x",
  label: "X (Twitter)",
  requiresAuth: true,
  async fetch(source: Source): Promise<NormalizedArticle[]> {
    const h = handle(source.identifier);

    if (process.env.X_API_PROVIDER) {
      // API path: wire your chosen X API provider here. Kept explicit so we
      // don't silently scrape when an API was intended.
      throw new Error(
        `X_API_PROVIDER="${process.env.X_API_PROVIDER}" 설정됨 — API 연동을 src/server/adapters/x.ts 에 구현하세요. (세션 스크래핑을 쓰려면 X_API_PROVIDER 를 비우세요)`,
      );
    }

    // Session scraping fallback.
    const items = await extractItemsWithSession({
      sourceId: source.id,
      url: `https://x.com/${h}`,
      itemSelector: 'article[data-testid="tweet"]',
      linkSelector: 'a[href*="/status/"]',
      limit: source.config?.maxItems ?? 20,
    });

    return items.map((it) => ({
      externalId: it.url ?? `${h}:${it.text.slice(0, 64)}`,
      url: it.url,
      title: it.text.slice(0, 120),
      body: it.text,
      author: `@${h}`,
      publishedAt: null,
    }));
  },
};
