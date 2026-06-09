import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

  return (
    <div className="space-y-4">
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
          <FeedCard key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
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
        {item.impact && (
          <span className={"shrink-0 rounded px-2 py-0.5 text-xs font-medium " + IMPACT_STYLE[item.impact]}>
            {IMPACT_LABEL[item.impact]}
          </span>
        )}
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
