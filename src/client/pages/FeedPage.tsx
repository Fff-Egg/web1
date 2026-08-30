import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { FeedFilter } from "../data/client.js";
import type { Impact } from "../../server/db/schema.js";
import { SourceTabs, tallyByProvider, SOURCE_ORDER } from "../components/SourceTabs.js";
import { FeedCard, dropFromFeedCache, IMPACT_STYLE, IMPACT_LABEL } from "../components/FeedCard.js";

/**
 * Feed — the day's transient picks (중요 / 검토 대상). These are exactly what the
 * 21시 sweep clears, so the page stays "today's churn". The two persistent buckets
 * that survive the sweep — ⭐저장 and 텔레그램 — live in the 보관함 page instead.
 */
export function FeedPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FeedFilter>({});
  const [provider, setProvider] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const feed = useQuery({
    queryKey: ["feed", filter],
    queryFn: () => api.listFeed(filter),
  });
  const bucketCounts = useQuery({
    queryKey: ["feedCounts"],
    queryFn: () => api.feedCounts(),
  });
  const bc = bucketCounts.data ?? { important: 0, low: 0, sourceReview: 0, saved: 0, telegram: 0 };

  const counts = useMemo(() => tallyByProvider(feed.data ?? [], SOURCE_ORDER), [feed.data]);
  const items = provider
    ? (feed.data ?? []).filter((i) => i.provider === provider)
    : feed.data ?? [];

  const sourceReview = filter.priority === "source-review";
  const review = filter.priority === "low" || sourceReview;

  const clearSel = () => setSelected(new Set());
  // Counts are a cheap aggregate; refresh them (and clear selection) after a bulk op.
  const afterBulk = () => {
    qc.invalidateQueries({ queryKey: ["feedCounts"] });
    clearSel();
  };
  const delMany = useMutation({
    mutationFn: (ids: number[]) => api.feedDeleteMany(ids),
    onMutate: (ids: number[]) => dropFromFeedCache(qc, new Set(ids)),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: afterBulk,
  });
  const promoteMany = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await api.promoteFeedItem(id);
    },
    onMutate: (ids: number[]) => dropFromFeedCache(qc, new Set(ids)),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: afterBulk,
  });
  const toggleSel = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const selectAll = () => setSelected(new Set(items.map((i) => i.id)));
  const ids = [...selected];

  return (
    <div className="space-y-4">
      {/* 중요 / 검토 대상 / 원문 확인 전환 */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          {([
            ["important", "중요"],
            ["low", "검토 대상"],
            ["source-review", "원문 확인"],
          ] as const).map(([key, label]) => {
            const on = (filter.priority ?? "important") === key;
            const n = key === "important" ? bc.important : key === "low" ? bc.low : bc.sourceReview;
            return (
              <button
                key={key}
                onClick={() => setFilter((f) => ({ ...f, priority: key === "important" ? undefined : key }))}
                className={
                  "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium " +
                  (on ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600")
                }
              >
                {label} <span className={on ? "text-slate-300" : "text-slate-400"}>{n}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-400">⭐저장 · 지난 텔레그램은 “보관함” 탭</p>
      </div>

      {filter.priority === "low" && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          낮은 중요도/개인적이라고 판별된 글입니다. 훑어보고 <strong>남기기</strong>(피드로) 또는{" "}
          <strong>삭제</strong>하세요. 여긴 다이제스트에 포함되지 않습니다.
        </p>
      )}
      {sourceReview && (
        <p className="rounded border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
          본문을 가져오지 못했거나 링크·이모지·티커·짧은 반응 문구만 수집된 항목입니다. 찌라시·루머·개인의견은
          여기가 아니라 일반 Feed에서 분석합니다. <strong>원문 보기</strong>로 읽은 뒤 <strong>확인 후 남기기</strong>
          또는 삭제하세요. 확인 전에는 다이제스트에 들어가지 않습니다.
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
                  {sourceReview ? "선택 확인 후 남기기" : "선택 남기기"}
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
