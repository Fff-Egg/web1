/**
 * Cross-tab "open this article in the Feed" channel.
 *
 * The digest's "피드에서 원문 보기" link (telegram items, which have no viewable
 * original) calls requestFeedArticle(id). App switches to the Feed tab and
 * FeedPage focuses that article — pulled from here on mount, or via the event
 * when the Feed is already showing.
 */
export const OPEN_FEED_ARTICLE = "fw:open-feed-article";

let pending: number | null = null;

export function requestFeedArticle(id: number): void {
  pending = id;
  window.dispatchEvent(new CustomEvent<number>(OPEN_FEED_ARTICLE, { detail: id }));
}

/** Read and clear the pending article id (FeedPage reads this on mount). */
export function takePendingFeedArticle(): number | null {
  const id = pending;
  pending = null;
  return id;
}
