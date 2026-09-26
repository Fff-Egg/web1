import type { Source } from "../db/schema.js";
import type { NormalizedArticle } from "./types.js";
import { listLinksWithSession, fetchWithSession } from "../auth/browser.js";

/**
 * Shared behavior for "list page behind a login" providers (naver_premium,
 * fanding): render the channel/creator page with the saved session, collect
 * post links, then pull the body for the newest few via the session.
 *
 * Selectors are best-effort and can be tuned per source via config
 * (`listSelector`, `bodySelector`).
 */
export async function fetchAuthList(
  source: Source,
  opts: { loginUrlHints?: string[] } = {},
): Promise<NormalizedArticle[]> {
  const maxItems = source.config?.maxItems ?? 10;
  const links = await listLinksWithSession({
    sourceId: source.id,
    url: source.identifier,
    linkSelector: source.config?.listSelector as string | undefined,
    limit: maxItems,
  });

  const out: NormalizedArticle[] = [];
  const enrichLimit = Math.min(links.length, 8);
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    let body: string | null = null;
    if (i < enrichLimit) {
      try {
        body = await fetchWithSession({
          sourceId: source.id,
          url: link.url,
          bodySelector: source.config?.bodySelector,
          loginUrlHints: opts.loginUrlHints,
        });
      } catch {
        body = null;
      }
    }
    out.push({
      externalId: link.url,
      url: link.url,
      title: link.title,
      body,
      author: source.label ?? null,
      publishedAt: null,
    });
  }
  return out;
}
