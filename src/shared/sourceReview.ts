/** Marker stored in an article body when X returned a post URL but no readable
 * text at all. It lets the analyzer fail open into the persistent "원문 확인"
 * bucket instead of discarding the post. */
export const SOURCE_REVIEW_MARKER = "[원문 본문 미수집 — 직접 확인 필요]";

function isXUrl(url: string | null | undefined): boolean {
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url?.trim() ?? "");
}

function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

/** Remove the boilerplate that often precedes the actual text of a retweet. */
function withoutRetweetPrefix(text: string): string {
  return text
    .replace(/^(?:RT\s+)+/i, "")
    .replace(/^@[A-Za-z0-9_]+\s*:\s*/, "")
    .trim();
}

/**
 * Very narrow social-reaction phrases. These carry no claim of their own and
 * usually mean the quoted/attached post was not returned by the X scraper.
 * Keep this list deliberately conservative: an unverified rumour or a personal
 * market opinion is still usable information and must go through normal Feed
 * analysis rather than being diverted here.
 */
function isReactionShell(text: string): boolean {
  const normalized = withoutRetweetPrefix(text)
    .toLocaleLowerCase("en")
    .replace(/[.!…。！？]+$/u, "")
    .trim();
  return (
    /^(?:so\s+)?excited to see(?: this)?$/i.test(normalized) ||
    /^this is (?:elite|great|amazing|excellent|incredible) work$/i.test(normalized) ||
    /^(?:thanks|thank you)(?: so much)?(?: for (?:sharing|this))?$/i.test(normalized) ||
    /^(?:자료\s*공유\s*)?(?:감사합니다|고맙습니다)$/u.test(normalized)
  );
}

/**
 * Deterministic source-quality guard. This is intentionally about *collection
 * completeness*, not source credibility. Rumours, unverified claims, personal
 * opinions and second-hand reports still contain analyzable information and
 * must go through the normal Feed pipeline.
 */
export function needsSourceReview(article: {
  title?: string | null;
  body?: string | null;
  url?: string | null;
}): boolean {
  const body = article.body?.trim() ?? "";
  if (body.includes(SOURCE_REVIEW_MARKER)) return true;
  if (!body) return true;
  if (!isXUrl(article.url)) return false;

  const signal = withoutUrls(body);
  if (!signal) return true;

  // Emoji/media/link only: after URL removal there is no letter or number from
  // which the model could infer even a minimal claim.
  const semanticTokens = signal
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (semanticTokens.length === 0) return true;

  // A bare cashtag (optionally followed by another ticker-like token) is often
  // just the visible title of an attached X Article. Do *not* treat ordinary
  // short names such as "삼성전자 HBM" as missing content: inclusiveness is the
  // safer default and the relevance model can still classify them normally.
  const cashtagOnly =
    semanticTokens.length <= 2 &&
    semanticTokens.some((token) => /^\$[A-Za-z0-9._-]{1,20}$/u.test(token)) &&
    semanticTokens.every((token) => /^[$#]?[A-Za-z0-9._+-]{1,20}$/u.test(token));
  if (cashtagOnly) return true;

  return isReactionShell(signal);
}

export function sourceReviewSummary(article: {
  title?: string | null;
  body?: string | null;
}): string {
  const visible = (article.body ?? "").replace(SOURCE_REVIEW_MARKER, "").trim();
  const hint = visible || article.title?.trim();
  return hint
    ? `[원문 확인 필요] 수집된 내용이 “${hint.slice(0, 100)}”처럼 링크·이모지·티커·반응 문구 수준이라 연결된 원문을 직접 확인해 주세요.`
    : "[원문 확인 필요] 게시물 주소는 수집했지만 본문을 가져오지 못했습니다. 연결된 원문을 직접 확인해 주세요.";
}
