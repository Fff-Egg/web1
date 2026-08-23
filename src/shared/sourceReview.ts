/** Marker stored in an article body when X returned a post shell but not the
 * attached Article's readable text. It lets the analyzer fail open into the
 * persistent "원문 확인" bucket instead of discarding the post. */
export const SOURCE_REVIEW_MARKER = "[원문 본문 미수집 — 직접 확인 필요]";

function isXUrl(url: string | null | undefined): boolean {
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url?.trim() ?? "");
}

function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic source-quality guard. The LLM must not decide that an empty X
 * Article shell is irrelevant: there is no body to judge. Very small X posts
 * containing only a ticker/name are handled the same way because they are often
 * the visible shell of an attached X Article.
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

  if (/\/(?:i\/)?article\//i.test(article.url ?? "")) return true;

  const signal = withoutUrls(body);
  if (!signal) return true;

  // "$ABCD", "삼성전자", "NVDA HBM"처럼 정보가 사실상 이름뿐인 X
  // shell만 대상으로 한다. 짧은 문장 전체를 잡지 않도록 문장부호/조사와
  // 길이를 함께 제한한다.
  const tokens = signal.split(/\s+/).filter(Boolean);
  const nameOnly =
    signal.length <= 32 &&
    tokens.length <= 3 &&
    !/[.!?。！？:;]/.test(signal) &&
    tokens.every((token) => /^[$#@]?[\p{L}\p{N}._+&/-]{1,20}$/u.test(token));
  return nameOnly;
}

export function sourceReviewSummary(article: {
  title?: string | null;
  body?: string | null;
}): string {
  const visible = (article.body ?? "").replace(SOURCE_REVIEW_MARKER, "").trim();
  const hint = visible || article.title?.trim();
  return hint
    ? `[원문 확인 필요] 수집된 내용이 “${hint.slice(0, 100)}” 정도로 짧아 판단하지 않았습니다. 연결된 원문을 직접 확인해 주세요.`
    : "[원문 확인 필요] 게시물 주소는 수집했지만 본문을 가져오지 못했습니다. 연결된 원문을 직접 확인해 주세요.";
}
