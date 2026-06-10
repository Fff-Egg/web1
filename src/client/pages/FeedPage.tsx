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

export function FeedPage() {
  const [filter, setFilter] = useState<FeedFilter>({});
  const [provider, setProvider] = useState<string | null>(null);
  const feed = useQuery({
    queryKey: ["feed", filter],
    queryFn: () => api.listFeed(filter),
  });

  const counts = useMemo(() => tallyByProvider(feed.data ?? [], SOURCE_ORDER), [feed.data]);
  const items = provider
    ? (feed.data ?? []).filter((i) => i.provider === provider)
    : feed.data ?? [];

  const review = filter.priority === "low";

  return (
    <div className="space-y-4">
      {/* 중요 / 검토 대상(낮은 중요도) 전환 */}
      <div className="flex items-center gap-1">
        {([
          ["important", "중요"],
          ["low", "검토 대상 (낮은 중요도/개인적)"],
        ] as const).map(([key, label]) => {
          const on = (filter.priority ?? "important") === key;
          return (
            <button
              key={key}
              onClick={() => setFilter((f) => ({ ...f, priority: key === "important" ? undefined : "low" }))}
              className={
                "rounded-full px-3 py-1 text-sm font-medium " +
                (on ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600")
              }
            >
              {label}
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
        {(filter.impact || filter.ticker || filter.theme) && (
          <button
            onClick={() => setFilter({})}
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

      <ul className="space-y-3">
        {items.map((item) => (
          <FeedCard key={item.id} item={item} review={review} />
        ))}
      </ul>
    </div>
  );
}

function FeedCard({ item, review }: { item: FeedItem; review?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["feed"] });
  const del = useMutation({ mutationFn: () => api.deleteFeedItem(item.id), onSuccess: invalidate });
  const promote = useMutation({ mutationFn: () => api.promoteFeedItem(item.id), onSuccess: invalidate });
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
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
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.impact && (
            <span className={"rounded px-2 py-0.5 text-xs font-medium " + IMPACT_STYLE[item.impact]}>
              {IMPACT_LABEL[item.impact]}
            </span>
          )}
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
