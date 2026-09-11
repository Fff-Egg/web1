import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { TrashFeedCard } from "../components/TrashFeedCard.js";

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
    qc.invalidateQueries({ queryKey: ["feedCounts"] });
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
  const feedBusy = fRestore.isPending || fPurge.isPending || fPurgeAll.isPending;
  const digestBusy = dRestore.isPending || dPurge.isPending || dPurgeAll.isPending;
  const feedError = feed.error ?? fRestore.error ?? fPurge.error ?? fPurgeAll.error;
  const digestError = digests.error ?? dRestore.error ?? dPurge.error ?? dPurgeAll.error;

  const toggle = (set: Set<number>, setSet: (s: Set<number>) => void, id: number) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setSet(n);
  };

  return (
    <div className="space-y-6">
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        직접 삭제하거나 정리 작업으로 이동된 항목입니다. 낮은 중요도 글은 먼저 <strong>검토 대상</strong>에
        보존되며, 낮다는 이유만으로 즉시 휴지통에 보내지 않습니다. 내용을 확인하고 <strong>복원</strong>하면
        기존 분류에 따라 Feed 또는 보관함에 다시 표시됩니다. 영구삭제는 되돌릴 수 없습니다.
      </p>

      {/* Feed 휴지통 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            Feed 휴지통 {feed.data ? `(${feed.data.length})` : ""}
          </h3>
          <button disabled={feedBusy} onClick={() => setSelFeed(new Set((feed.data ?? []).map((i) => i.id)))} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600">전체 선택</button>
          {selFeed.size > 0 && (
            <>
              <button disabled={feedBusy} onClick={() => fRestore.mutate([...selFeed])} className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">선택 복원</button>
              <button disabled={feedBusy} onClick={() => { if (confirm(`선택한 글 ${selFeed.size}건을 영구삭제할까요? 되돌릴 수 없습니다.`)) fPurge.mutate([...selFeed]); }} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white">선택 영구삭제</button>
              <button disabled={feedBusy} onClick={() => setSelFeed(new Set())} className="text-xs text-slate-400 underline">해제</button>
            </>
          )}
          {(feed.data?.length ?? 0) > 0 && (
            <button disabled={feedBusy} onClick={() => { if (confirm("화면에 표시되지 않은 항목까지 Feed 휴지통을 전부 영구삭제할까요? 되돌릴 수 없습니다.")) fPurgeAll.mutate(); }} className="ml-auto rounded border border-red-200 px-2 py-0.5 text-xs text-red-600">전체 삭제</button>
          )}
        </div>
        <p className="mb-2 text-xs text-slate-400">최근 삭제 순으로 최대 1,000건을 표시합니다. Feed의 날짜·소스 필터는 적용되지 않습니다.</p>
        {feed.isLoading && <p className="text-sm text-slate-500">휴지통을 불러오는 중…</p>}
        {feedError && <p role="alert" className="text-sm text-red-600">{feedError.message}</p>}
        {feed.data && feed.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {feed.data?.map((item) => (
            <TrashFeedCard
              key={item.id}
              item={item}
              checked={selFeed.has(item.id)}
              disabled={feedBusy}
              onToggle={() => toggle(selFeed, setSelFeed, item.id)}
              onRestore={() => fRestore.mutate([item.id])}
              onPurge={() => { if (confirm("이 글을 영구삭제할까요? 되돌릴 수 없습니다.")) fPurge.mutate([item.id]); }}
            />
          ))}
        </ul>
      </section>

      {/* 다이제스트 휴지통 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            다이제스트 휴지통 {digests.data ? `(${digests.data.length})` : ""}
          </h3>
          <button disabled={digestBusy} onClick={() => setSelDigest(new Set((digests.data ?? []).map((d) => d.id)))} className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600">전체 선택</button>
          {selDigest.size > 0 && (
            <>
              <button disabled={digestBusy} onClick={() => dRestore.mutate([...selDigest])} className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">선택 복원</button>
              <button disabled={digestBusy} onClick={() => { if (confirm(`선택한 다이제스트 ${selDigest.size}건을 영구삭제할까요? 되돌릴 수 없습니다.`)) dPurge.mutate([...selDigest]); }} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white">선택 영구삭제</button>
              <button disabled={digestBusy} onClick={() => setSelDigest(new Set())} className="text-xs text-slate-400 underline">해제</button>
            </>
          )}
          {(digests.data?.length ?? 0) > 0 && (
            <button disabled={digestBusy} onClick={() => { if (confirm("다이제스트 휴지통을 전부 영구삭제할까요? 되돌릴 수 없습니다.")) dPurgeAll.mutate(); }} className="ml-auto rounded border border-red-200 px-2 py-0.5 text-xs text-red-600">전체 삭제</button>
          )}
        </div>
        {digests.isLoading && <p className="text-sm text-slate-500">다이제스트 휴지통을 불러오는 중…</p>}
        {digestError && <p role="alert" className="text-sm text-red-600">{digestError.message}</p>}
        {digests.data && digests.data.length === 0 && <p className="text-sm text-slate-400">비어 있음</p>}
        <ul className="space-y-2">
          {digests.data?.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded border border-slate-200 bg-white p-3">
              <input type="checkbox" aria-label={`선택: ${d.title ?? d.periodStart ?? `#${d.id}`}`} checked={selDigest.has(d.id)} disabled={digestBusy} onChange={() => toggle(selDigest, setSelDigest, d.id)} className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{d.title ?? d.periodStart ?? `#${d.id}`}</div>
                <div className="text-xs text-slate-400">
                  {d.periodStart}
                  {d.periodEnd && d.periodEnd !== d.periodStart ? ` ~ ${d.periodEnd}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button disabled={digestBusy} onClick={() => dRestore.mutate([d.id])} className="text-blue-600 hover:underline">복원</button>
                <button disabled={digestBusy} onClick={() => { if (confirm("이 다이제스트를 영구삭제할까요? 되돌릴 수 없습니다.")) dPurge.mutate([d.id]); }} className="text-red-600 hover:underline">영구삭제</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
