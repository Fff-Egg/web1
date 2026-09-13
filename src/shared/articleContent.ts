export interface ContentLink {
  url: string;
  status: "extracted" | "unavailable";
  title?: string;
  reason?: string;
}

export interface ArticleContentMeta {
  version: 1;
  status: "extracted" | "partial" | "post" | "unknown";
  method: "page" | "feed" | "post" | "session";
  checkedAt: string;
  reason?: string;
  links: ContentLink[];
  sourceUrls?: string[];
  pending?: boolean;
}

export interface ReadingCache {
  version: 1;
  key: string;
  chunks: Record<string, string>;
  text?: string;
  inputChars: number;
  chunkCount: number;
  completedAt?: string;
}

export function contentScope(meta?: ArticleContentMeta | null): string {
  if (!meta) return "수집 범위 미확인";
  const label = { extracted: "원문 페이지 본문 추출", partial: "일부 수집", post: "게시글 본문 수집", unknown: "수집 범위 미확인" }[meta.status];
  const failed = meta.links.filter(x => x.status === "unavailable").length;
  return `${label}${meta.reason ? ` · ${meta.reason}` : ""}${failed ? ` · 연결 원문 ${failed}건 미수집` : ""}`;
}

/** Lossless, bounded splits. Every character, including paragraph boundaries, is retained. */
export function splitWholeText(text: string, limit = 12000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Invalid text chunk size");
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n", end - 1);
      if (paragraph >= start + limit / 2) end = paragraph + 1;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
