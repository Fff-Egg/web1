import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { ExcludedItem } from "../data/client.js";

/** When the item was analyzed (filtered out), in KST. */
function fmt(d?: string | Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 제외됨 — articles the 1st-pass filter dropped (relevant=false), never shown in
 * the feed. Lets you catch wrongly-filtered good articles: "살리기" pulls one
 * into the feed (a positive signal), "제외 확정" trashes it (a negative signal).
 * Both teach the filter (few-shot, refreshed daily at 21시).
 */
export function ExcludedPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["excluded"], queryFn: () => api.listExcluded() });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["excluded"] });
    qc.invalidateQueries({ queryKey: ["feed"] });
    qc.invalidateQueries({ queryKey: ["feedCounts"] });
  };
  const rescue = useMutation({ mutationFn: (id: number) => api.rescueExcluded(id), onSuccess: invalidate });
  const dismiss = useMutation({ mutationFn: (id: number) => api.deleteFeedItem(id), onSuccess: invalidate });

  return (
    <div className="space-y-4">
      <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        1차 필터에서 <strong>관련 없음</strong>으로 걸러져 피드에 안 뜬 글입니다. 잘못 걸러진 좋은 글은{" "}
        <strong>살리기</strong>(피드로 + 양성 신호), 확실히 불필요하면 <strong>제외 확정</strong>(휴지통 + 음성 신호).
        반영은 매일 21시에 1차 필터로 학습됩니다.
      </p>

      {list.isLoading && <p className="text-slate-500">로딩…</p>}
      {list.error && <p className="text-red-600">{(list.error as Error).message}</p>}
      {list.data && list.data.length === 0 && (
        <p className="text-slate-500">제외된 글이 없습니다.</p>
      )}

      <ul className="space-y-3">
        {list.data?.map((item) => (
          <ExcludedCard
            key={item.id}
            item={item}
            onRescue={() => rescue.mutate(item.id)}
            onDismiss={() => dismiss.mutate(item.id)}
            busy={rescue.isPending || dismiss.isPending}
          />
        ))}
      </ul>
    </div>
  );
}

function ExcludedCard({
  item,
  onRescue,
  onDismiss,
  busy,
}: {
  item: ExcludedItem;
  onRescue: () => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
            {item.addedAt && <span className="text-slate-300"> · {fmt(item.addedAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={onRescue}
            disabled={busy}
            className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
          >
            살리기
          </button>
          <button
            onClick={onDismiss}
            disabled={busy}
            title="제외 확정(휴지통)"
            className="text-slate-300 hover:text-red-600 disabled:opacity-50"
          >
            🗑
          </button>
        </div>
      </div>

      {item.snippet && (
        <div className="mt-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {open ? "▾ 본문 접기" : "▸ 본문 미리보기"}
          </button>
          {open && (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">
              {item.snippet}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
