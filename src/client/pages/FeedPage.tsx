import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "../data/client.js";
import type { FeedFilter, FeedItem } from "../data/client.js";
import type { Impact } from "../../server/db/schema.js";
import { SourceTabs, tallyByProvider, SOURCE_ORDER } from "../components/SourceTabs.js";

const IMPACT_STYLE: Record<Impact, string> = {
  bullish: "bg-green-100 text-green-700",
  bearish: "bg-red-100 text-red-700",
  neutral: "bg-slate-100 text-slate-600",
};
const IMPACT_LABEL: Record<Impact, string> = {
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

export function FeedPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FeedFilter>({});
  const [provider, setProvider] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // A single article opened from the digest's "피드에서 원문 보기" link (e.g.
  // telegram, no viewable original) via ?article=<id>, usually in a new tab.
  // While focused we render only that article — no full feed list, so it's light.
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

  const feed = useQuery({
    queryKey: ["feed", filter],
    queryFn: () => api.listFeed(filter),
    enabled: focusId == null,
  });
  const bucketCounts = useQuery({
    queryKey: ["feedCounts"],
    queryFn: () => api.feedCounts(),
    enabled: focusId == null,
  });
  const bc = bucketCounts.data ?? { important: 0, low: 0, saved: 0 };

  const counts = useMemo(() => tallyByProvider(feed.data ?? [], SOURCE_ORDER), [feed.data]);
  const items = provider
    ? (feed.data ?? []).filter((i) => i.provider === provider)
    : feed.data ?? [];

  const review = filter.priority === "low";

  const clearSel = () => setSelected(new Set());
  const onDone = () => {
    qc.invalidateQueries({ queryKey: ["feed"] });
    qc.invalidateQueries({ queryKey: ["feedCounts"] });
    clearSel();
  };
  const delMany = useMutation({ mutationFn: (ids: number[]) => api.feedDeleteMany(ids), onSuccess: onDone });
  const promoteMany = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await api.promoteFeedItem(id);
    },
    onSuccess: onDone,
  });
  const toggleSel = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const selectAll = () => setSelected(new Set(items.map((i) => i.id)));
  const ids = [...selected];

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
              전체 피드 보기 →
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
      {/* 중요 / 검토 대상(낮은 중요도) 전환 */}
      <div className="flex items-center gap-1">
        {([
          ["important", "중요"],
          ["low", "검토 대상"],
          ["saved", "⭐ 저장됨"],
        ] as const).map(([key, label]) => {
          const on = (filter.priority ?? "important") === key;
          const n = key === "important" ? bc.important : key === "low" ? bc.low : bc.saved;
          return (
            <button
              key={key}
              onClick={() => setFilter((f) => ({ ...f, priority: key === "important" ? undefined : key }))}
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

      {review && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          낮은 중요도/개인적이라고 판별된 글입니다. 훑어보고 <strong>남기기</strong>(피드로) 또는{" "}
          <strong>삭제</strong>하세요. 여긴 다이제스트에 포함되지 않습니다.
        </p>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">impact:</span>
        {(["bullish", "bearish", "neutral"] as Impact[]).map((im) => (
          <button
            key={im}
            onClick={() =>
              setFilter((f) => ({ ...f, impact: f.impact === im ? undefined : im }))
            }
            className={
              "rounded px-2 py-1 text-xs font-medium " +
              (filter.impact === im ? IMPACT_STYLE[im] : "bg-white text-slate-500 border border-slate-200")
            }
          >
            {IMPACT_LABEL[im]}
          </button>
        ))}
        <input
          value={filter.ticker ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, ticker: e.target.value || undefined }))}
          placeholder="티커 (예: NVDA)"
          className="rounded border border-slate-200 px-2 py-1 text-xs"
        />
        <input
          value={filter.theme ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, theme: e.target.value || undefined }))}
          placeholder="테마"
          className="rounded border border-slate-200 px-2 py-1 text-xs"
        />
        <span className="text-xs text-slate-500">추가일:</span>
        <input
          type="date"
          value={filter.date ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, date: e.target.value || undefined }))}
          className="rounded border border-slate-200 px-2 py-1 text-xs"
        />
        {(filter.impact || filter.ticker || filter.theme || filter.date) && (
          <button
            onClick={() => setFilter((f) => ({ priority: f.priority }))}
            className="text-xs text-slate-400 underline"
          >
            필터 초기화
          </button>
        )}
      </div>

      <SourceTabs counts={counts} active={provider} onChange={setProvider} />

      {feed.isLoading && <p className="text-slate-500">로딩…</p>}
      {feed.error && <p className="text-red-600">{(feed.error as Error).message}</p>}
      {feed.data && feed.data.length === 0 && (
        <p className="text-slate-500">
          분석된 글이 아직 없습니다. (수집·분석이 돌면 여기에 표시됩니다)
        </p>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button onClick={selectAll} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600">
            전체 선택
          </button>
          {selected.size > 0 && (
            <>
              <span className="text-xs text-slate-500">{selected.size}개 선택됨</span>
              <button
                onClick={() => delMany.mutate(ids)}
                disabled={delMany.isPending}
                className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                선택 삭제(휴지통)
              </button>
              {review && (
                <button
                  onClick={() => promoteMany.mutate(ids)}
                  disabled={promoteMany.isPending}
                  className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  선택 남기기
                </button>
              )}
              <button onClick={clearSel} className="text-xs text-slate-400 underline">
                선택 해제
              </button>
            </>
          )}
        </div>
      )}

      <ul className="space-y-3">
        {items.map((item) => (
          <FeedCard
            key={item.id}
            item={item}
            review={review}
            checked={selected.has(item.id)}
            onToggle={() => toggleSel(item.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function FeedCard({
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
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["feed"] });
    qc.invalidateQueries({ queryKey: ["feedCounts"] });
  };
  const del = useMutation({ mutationFn: () => api.deleteFeedItem(item.id), onSuccess: invalidate });
  const promote = useMutation({ mutationFn: () => api.promoteFeedItem(item.id), onSuccess: invalidate });
  const save = useMutation({ mutationFn: () => api.setSavedFeedItem(item.id, !item.saved), onSuccess: invalidate });
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
            className="font-medium text-slate-900 hover:underline"
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
              dangerouslySetInnerHTML={{ __html: marked.parse(item.fullText) as string }}
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
