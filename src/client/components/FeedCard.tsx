import { useState } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { FeedItem } from "../data/client.js";
import type { Impact } from "../../server/db/schema.js";
import { renderMarkdown } from "../markdown.js";

/**
 * Optimistically drop articles from every cached feed list so trash/promote feel
 * instant — no full refetch (which would re-pull up to 500 items). Returns a
 * rollback to restore the snapshot if the mutation fails.
 */
export async function dropFromFeedCache(qc: QueryClient, ids: Set<number>): Promise<() => void> {
  await qc.cancelQueries({ queryKey: ["feed"] });
  const prev = qc.getQueriesData<FeedItem[]>({ queryKey: ["feed"] });
  qc.setQueriesData<FeedItem[]>({ queryKey: ["feed"] }, (old) =>
    old ? old.filter((x) => !ids.has(x.id)) : old,
  );
  return () => prev.forEach(([key, data]) => qc.setQueryData(key, data));
}

/**
 * Optimistically toggle `saved` on an article across cached feed lists so the
 * star reacts instantly with no full refetch. The card is left in place — even
 * in the ⭐저장 bucket — so an accidental un-save is easy to undo; it only drops
 * out of the saved bucket on the next refresh/refetch. Returns a rollback.
 */
export async function setSavedInFeedCache(qc: QueryClient, id: number, saved: boolean): Promise<() => void> {
  await qc.cancelQueries({ queryKey: ["feed"] });
  const prev = qc.getQueriesData<FeedItem[]>({ queryKey: ["feed"] });
  qc.setQueriesData<FeedItem[]>({ queryKey: ["feed"] }, (old) =>
    old ? old.map((x) => (x.id === id ? { ...x, saved } : x)) : old,
  );
  return () => prev.forEach(([key, data]) => qc.setQueryData(key, data));
}

export const IMPACT_STYLE: Record<Impact, string> = {
  bullish: "bg-green-100 text-green-700",
  bearish: "bg-red-100 text-red-700",
  neutral: "bg-slate-100 text-slate-600",
};
export const IMPACT_LABEL: Record<Impact, string> = {
  bullish: "상승",
  bearish: "하락",
  neutral: "중립",
};

/** When the item entered the feed (analysis time), in KST. */
function fmtAdded(d?: string | Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FeedCard({
  item,
  review,
  checked,
  onToggle,
  defaultOpenBody,
}: {
  item: FeedItem;
  review?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  defaultOpenBody?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [showBody, setShowBody] = useState(!!defaultOpenBody);
  const qc = useQueryClient();
  // Trash/promote/star: update the cache instantly (no full feed refetch); refresh
  // only the cheap bucket counts, and roll back if the mutation fails.
  const del = useMutation({
    mutationFn: () => api.deleteFeedItem(item.id),
    onMutate: () => dropFromFeedCache(qc, new Set([item.id])),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedCounts"] }),
  });
  const promote = useMutation({
    mutationFn: () => api.promoteFeedItem(item.id),
    onMutate: () => dropFromFeedCache(qc, new Set([item.id])),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedCounts"] }),
  });
  const save = useMutation({
    mutationFn: () => api.setSavedFeedItem(item.id, !item.saved),
    onMutate: () => setSavedInFeedCache(qc, item.id, !item.saved),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedCounts"] }),
  });
  return (
    <li className={"rounded-lg border bg-white p-4 " + (checked ? "border-blue-400 ring-1 ring-blue-200" : "border-slate-200")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {onToggle && (
            <input
              type="checkbox"
              checked={checked ?? false}
              onChange={onToggle}
              className="mt-1 h-4 w-4 shrink-0"
            />
          )}
          <div className="min-w-0">
          <a
            href={item.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="break-words font-medium text-slate-900 hover:underline"
          >
            {item.title ?? "(제목 없음)"}
          </a>
          <div className="mt-0.5 text-xs text-slate-400">
            {item.sourceLabel ?? item.provider}
            {item.addedAt && <span className="text-slate-300"> · {fmtAdded(item.addedAt)}</span>}
          </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {item.impact && (
            <span className={"rounded px-2 py-0.5 text-xs font-medium " + IMPACT_STYLE[item.impact]}>
              {IMPACT_LABEL[item.impact]}
            </span>
          )}
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            title={item.saved ? "저장 해제" : "나중에 보기 저장"}
            className={"text-base disabled:opacity-50 " + (item.saved ? "text-amber-500" : "text-slate-300 hover:text-amber-500")}
          >
            {item.saved ? "★" : "☆"}
          </button>
          {review && (
            <button
              onClick={() => promote.mutate()}
              disabled={promote.isPending}
              title="피드로 남기기"
              className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
            >
              남기기
            </button>
          )}
          <button
            onClick={() => del.mutate()}
            disabled={del.isPending}
            title="휴지통으로"
            className="text-slate-300 hover:text-red-600 disabled:opacity-50"
          >
            🗑
          </button>
        </div>
      </div>

      {item.summary && <p className="mt-2 text-sm text-slate-700">{item.summary}</p>}

      <div className="mt-2 flex flex-wrap gap-1">
        {item.tickers?.map((t) => (
          <span key={t} className="rounded bg-slate-900 px-1.5 py-0.5 text-xs text-white">
            {t}
          </span>
        ))}
        {item.themes?.map((t) => (
          <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
            #{t}
          </span>
        ))}
      </div>

      {item.implications && (
        <div className="mt-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {open ? "▾ 왜 중요한지 접기" : "▸ 왜 중요한지"}
          </button>
          {open && (
            <p className="mt-1 rounded bg-blue-50 p-2 text-sm text-slate-700">
              {item.implications}
            </p>
          )}
        </div>
      )}

      {item.body && (
        <div className="mt-2">
          <button
            onClick={() => setShowBody((v) => !v)}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {showBody ? "▾ 원문 내용 접기" : "▸ 원문 내용 보기"}
          </button>
          {showBody && (
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">
              {item.body}
            </pre>
          )}
        </div>
      )}

      {item.fullText && (
        <div className="mt-2">
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-xs font-medium text-slate-700 hover:underline"
          >
            {showFull ? "▾ 전체 분석 접기" : "▸ 전체 분석 보기"}
          </button>
          {showFull && (
            <div
              className="prose-digest mt-1 rounded border border-slate-200 bg-slate-50 p-3 text-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.fullText) }}
            />
          )}
        </div>
      )}

      {item.url && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            원문 보기 ↗ <span className="text-slate-400">({item.sourceLabel ?? item.provider})</span>
          </a>
        </div>
      )}
    </li>
  );
}
