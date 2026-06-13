import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { FeedCard } from "../components/FeedCard.js";

type Bucket = "saved" | "telegram";

/**
 * 보관함 — the two buckets that survive the 21시 sweep and so keep accumulating:
 * ⭐저장됨 (read-later) and 텔레그램 (no viewable original; kept for digest deep
 * links). Splitting them off keeps the Feed page to the day's transient churn.
 *
 * Also hosts the digest's "피드에서 원문 보기" deep link (?article=<id>): App routes
 * it here, and we render just that one article (body expanded) — telegram lives
 * here now, so its original is read in this page.
 */
export function ArchivePage() {
  // A single article opened from a digest (?article=<id>, usually a new tab).
  // While focused we render only that article — no list, so it's light.
  const [focusId, setFocusId] = useState<number | null>(() => {
    const a = new URLSearchParams(window.location.search).get("article");
    return a ? Number(a) : null;
  });
  const focused = useQuery({
    queryKey: ["feedItem", focusId],
    queryFn: () => api.getFeedItem(focusId as number),
    enabled: focusId != null,
  });
  const clearFocus = () => {
    setFocusId(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("article");
    window.history.replaceState(null, "", u.pathname + u.search + u.hash);
  };

  const [bucket, setBucket] = useState<Bucket>("saved");
  const counts = useQuery({
    queryKey: ["feedCounts"],
    queryFn: () => api.feedCounts(),
    enabled: focusId == null,
  });
  const bc = counts.data ?? { important: 0, low: 0, saved: 0, telegram: 0 };
  const list = useQuery({
    queryKey: ["feed", { priority: bucket }],
    queryFn: () => api.listFeed({ priority: bucket }),
    enabled: focusId == null,
  });
  const items = list.data ?? [];

  // Focused single-article view (opened from the digest) — light, no full list.
  if (focusId != null) {
    return (
      <div className="space-y-4">
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-amber-800">
              📌 다이제스트에서 선택한 글 — 저장된 원문
            </span>
            <button
              onClick={clearFocus}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              보관함 전체 보기 →
            </button>
          </div>
          {focused.isLoading && <p className="text-sm text-slate-500">불러오는 중…</p>}
          {focused.isSuccess && !focused.data && (
            <p className="text-sm text-slate-500">글을 찾을 수 없습니다 (삭제되었거나 존재하지 않음).</p>
          )}
          {focused.data && (
            <ul>
              <FeedCard item={focused.data} defaultOpenBody />
            </ul>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        {([
          ["saved", "⭐ 저장됨"],
          ["telegram", "텔레그램"],
        ] as const).map(([key, label]) => {
          const on = bucket === key;
          const n = key === "saved" ? bc.saved : bc.telegram;
          return (
            <button
              key={key}
              onClick={() => setBucket(key)}
              className={
                "rounded-full px-3 py-1 text-sm font-medium " +
                (on ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600")
              }
            >
              {label} <span className={on ? "text-slate-300" : "text-slate-400"}>{n}</span>
            </button>
          );
        })}
      </div>

      <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        {bucket === "saved"
          ? "★로 저장한 글입니다. 21시 정리에서 제외되어 계속 쌓입니다. ★를 다시 누르면 저장 해제됩니다."
          : "텔레그램 글입니다. 원문 링크가 없어 여기 모아 보관하며(21시 정리 제외), 다이제스트의 텔레그램 인용도 이 글로 연결됩니다."}
      </p>

      {list.isLoading && <p className="text-slate-500">로딩…</p>}
      {list.error && <p className="text-red-600">{(list.error as Error).message}</p>}
      {list.data && items.length === 0 && (
        <p className="text-slate-500">
          {bucket === "saved" ? "저장한 글이 없습니다. 피드에서 ★를 눌러 저장하세요." : "텔레그램 글이 없습니다."}
        </p>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <FeedCard key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
