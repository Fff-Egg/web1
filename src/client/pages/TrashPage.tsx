import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";

/**
 * Trash — soft-deleted Feed items and Digests. Multi-select to restore or
 * permanently delete in batches; "전체 삭제" empties a section. Items only leave
 * the app from here.
 */
export function TrashPage() {
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ["trashFeed"], queryFn: () => api.trashFeed() });
  const digests = useQuery({ queryKey: ["trashDigests"], queryFn: () => api.trashDigests() });

  const [selFeed, setSelFeed] = useState<Set<number>>(new Set());
  const [selDigest, setSelDigest] = useState<Set<number>>(new Set());

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["trashFeed"] });
    qc.invalidateQueries({ queryKey: ["trashDigests"] });
    qc.invalidateQueries({ queryKey: ["feed"] });
    qc.invalidateQueries({ queryKey: ["digests"] });
  };
  const onFeedDone = () => { invalidate(); setSelFeed(new Set()); };
  const onDigestDone = () => { invalidate(); setSelDigest(new Set()); };

  const fRestore = useMutation({ mutationFn: (ids: number[]) => api.feedRestoreMany(ids), onSuccess: onFeedDone });
  const fPurge = useMutation({ mutationFn: (ids: number[]) => api.feedPurgeMany(ids), onSuccess: onFeedDone });
  const fPurgeAll = useMutation({ mutationFn: () => api.feedPurgeAll(), onSuccess: onFeedDone });
  const dRestore = useMutation({ mutationFn: (ids: number[]) => api.digestRestoreMany(ids), onSuccess: onDigestDone });
  const dPurge = useMutation({ mutationFn: (ids: number[]) => api.digestPurgeMany(ids), onSuccess: onDigestDone });
  const dPurgeAll = useMutation({ mutationFn: () => api.digestPurgeAll(), onSuccess: onDigestDone });

  const toggle = (set: Set<number>, setSet: (s: Set<number>) => void, id: number) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setSet(n);
  };

  return (
    <div className="space-y-6">
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        삭제한 항목은 여기로 옵니다. 선택해서 <strong>복원</strong>하거나 <strong>영구삭제</strong>할 수
        있고, <strong>전체 삭제</strong>로 비울 수 있어요. 영구삭제는 되돌릴 수 없습니다.
      </p>

      {/* Feed 휴지통 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            Feed 휴지통 {feed.data ? `(${feed.data.length})` : ""}
          </h3>
          <button onClick={() => setSelFeed(new Set((feed.data ?? []).map((i) => i.id)))} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600">전체 선택</button>
          {selFeed.size > 0 && (
            <>
              <button onClick={() => fRestore.mutate([...selFeed])} className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">선택 복원</button>
              <button onClick={() => fPurge.mutate([...selFeed])} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white">선택 영구삭제</button>
              <button onClick={() => setSelFeed(new Set())} className="text-xs text-slate-400 underline">해제</button>
            </>
          )}
          {(feed.data?.length ?? 0) > 0 && (
            <button onClick={() => { if (confirm("Feed 휴지통을 전부 영구삭제할까요?")) fPurgeAll.mutate(); }} className="ml-auto rounded border border-red-200 px-2 py-0.5 text-xs text-red-600">전체 삭제</button>
          )}
        </div>
        {feed.data && feed.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {feed.data?.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded border border-slate-200 bg-white p-3">
              <input type="checkbox" checked={selFeed.has(item.id)} onChange={() => toggle(selFeed, setSelFeed, item.id)} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.title ?? "(제목 없음)"}</div>
                <div className="text-xs text-slate-400">{item.sourceLabel ?? item.provider}</div>
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => fRestore.mutate([item.id])} className="text-blue-600 hover:underline">복원</button>
                <button onClick={() => fPurge.mutate([item.id])} className="text-red-600 hover:underline">영구삭제</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 다이제스트 휴지통 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            다이제스트 휴지통 {digests.data ? `(${digests.data.length})` : ""}
          </h3>
          <button onClick={() => setSelDigest(new Set((digests.data ?? []).map((d) => d.id)))} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600">전체 선택</button>
          {selDigest.size > 0 && (
            <>
              <button onClick={() => dRestore.mutate([...selDigest])} className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">선택 복원</button>
              <button onClick={() => dPurge.mutate([...selDigest])} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white">선택 영구삭제</button>
              <button onClick={() => setSelDigest(new Set())} className="text-xs text-slate-400 underline">해제</button>
            </>
          )}
          {(digests.data?.length ?? 0) > 0 && (
            <button onClick={() => { if (confirm("다이제스트 휴지통을 전부 영구삭제할까요?")) dPurgeAll.mutate(); }} className="ml-auto rounded border border-red-200 px-2 py-0.5 text-xs text-red-600">전체 삭제</button>
          )}
        </div>
        {digests.data && digests.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {digests.data?.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded border border-slate-200 bg-white p-3">
              <input type="checkbox" checked={selDigest.has(d.id)} onChange={() => toggle(selDigest, setSelDigest, d.id)} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{d.title ?? d.periodStart ?? `#${d.id}`}</div>
                <div className="text-xs text-slate-400">
                  {d.periodStart}
                  {d.periodEnd && d.periodEnd !== d.periodStart ? ` ~ ${d.periodEnd}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => dRestore.mutate([d.id])} className="text-blue-600 hover:underline">복원</button>
                <button onClick={() => dPurge.mutate([d.id])} className="text-red-600 hover:underline">영구삭제</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
