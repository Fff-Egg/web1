import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";

/**
 * Trash — soft-deleted Feed items and Digests. Restore puts them back; permanent
 * delete removes them for good. Items only leave the app from here.
 */
export function TrashPage() {
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ["trashFeed"], queryFn: () => api.trashFeed() });
  const digests = useQuery({ queryKey: ["trashDigests"], queryFn: () => api.trashDigests() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["trashFeed"] });
    qc.invalidateQueries({ queryKey: ["trashDigests"] });
    qc.invalidateQueries({ queryKey: ["feed"] });
    qc.invalidateQueries({ queryKey: ["digests"] });
  };

  const restoreFeed = useMutation({ mutationFn: (id: number) => api.restoreFeedItem(id), onSuccess: invalidate });
  const purgeFeed = useMutation({ mutationFn: (id: number) => api.purgeFeedItem(id), onSuccess: invalidate });
  const restoreDigest = useMutation({ mutationFn: (id: number) => api.restoreDigest(id), onSuccess: invalidate });
  const purgeDigest = useMutation({ mutationFn: (id: number) => api.purgeDigest(id), onSuccess: invalidate });

  return (
    <div className="space-y-6">
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        삭제한 항목은 여기로 옵니다. <strong>복원</strong>하면 되살아나고, <strong>영구삭제</strong>해야
        완전히 사라집니다.
      </p>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          Feed 휴지통 {feed.data ? `(${feed.data.length})` : ""}
        </h3>
        {feed.data && feed.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {feed.data?.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-white p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.title ?? "(제목 없음)"}</div>
                <div className="text-xs text-slate-400">{item.sourceLabel ?? item.provider}</div>
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => restoreFeed.mutate(item.id)} className="text-blue-600 hover:underline">
                  복원
                </button>
                <button onClick={() => purgeFeed.mutate(item.id)} className="text-red-600 hover:underline">
                  영구삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          다이제스트 휴지통 {digests.data ? `(${digests.data.length})` : ""}
        </h3>
        {digests.data && digests.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {digests.data?.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 rounded border border-slate-200 bg-white p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{d.title ?? d.periodStart ?? `#${d.id}`}</div>
                <div className="text-xs text-slate-400">
                  {d.periodStart}
                  {d.periodEnd && d.periodEnd !== d.periodStart ? ` ~ ${d.periodEnd}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => restoreDigest.mutate(d.id)} className="text-blue-600 hover:underline">
                  복원
                </button>
                <button onClick={() => purgeDigest.mutate(d.id)} className="text-red-600 hover:underline">
                  영구삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
