import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "../data/client.js";

const todayStr = () => new Date().toLocaleDateString("en-CA");

/**
 * Daily Digest — generate a synthesized report over a date range (with a name),
 * browse saved reports, and trash/restore them.
 */
export function DigestPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["digests"], queryFn: () => api.listDigests() });
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);

  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState(todayStr());
  const [title, setTitle] = useState("");

  // Default to the newest saved digest once loaded.
  useEffect(() => {
    if (selectedId === undefined && list.data && list.data.length > 0) {
      setSelectedId(list.data[0].id);
    }
  }, [list.data, selectedId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["digests"] });
    qc.invalidateQueries({ queryKey: ["digest"] });
  };

  const generate = useMutation({
    mutationFn: () => api.generateDigest({ start, end, title: title || undefined }),
    onSuccess: (res) => {
      invalidate();
      if (res?.id) setSelectedId(res.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteDigest(id),
    onSuccess: () => {
      invalidate();
      setSelectedId(undefined);
    },
  });

  const digest = useQuery({
    queryKey: ["digest", selectedId],
    queryFn: () => api.getDigest(selectedId),
    enabled: selectedId !== undefined,
  });

  const html = digest.data ? marked.parse(digest.data.markdown) : "";

  return (
    <div className="space-y-4">
      {/* Generate a new digest */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">새 다이제스트 만들기</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            시작일
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-slate-500">
            종료일
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex-1 text-xs text-slate-500">
            이름 (선택)
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 6월 2주차 반도체"
              className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {generate.isPending ? "생성 중…" : "생성"}
          </button>
        </div>
        {generate.data && generate.data.itemCount === 0 && (
          <p className="mt-2 text-xs text-amber-600">이 기간에 1차로 뽑힌 글이 없어 생성하지 못했습니다.</p>
        )}
        {generate.error && (
          <p className="mt-2 text-xs text-red-600">{(generate.error as Error).message}</p>
        )}
      </section>

      {/* Saved digests */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">저장된 다이제스트:</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {(!list.data || list.data.length === 0) && <option value="">(없음)</option>}
          {list.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title ?? d.periodStart} {d.periodStart && d.periodEnd && d.periodStart !== d.periodEnd ? `(${d.periodStart}~${d.periodEnd})` : ""}
            </option>
          ))}
        </select>
        {selectedId !== undefined && (
          <button
            onClick={() => remove.mutate(selectedId)}
            className="text-xs text-slate-400 hover:text-red-600"
          >
            🗑 휴지통으로
          </button>
        )}
      </div>

      {list.data && list.data.length === 0 && (
        <p className="text-slate-500">
          저장된 다이제스트가 없습니다. 위에서 기간을 정해 “생성”을 누르세요.
        </p>
      )}
      {digest.isLoading && <p className="text-slate-500">로딩…</p>}
      {digest.error && <p className="text-red-600">{(digest.error as Error).message}</p>}

      {digest.data && (
        <article
          className="prose-digest rounded-lg border border-slate-200 bg-white p-5"
          dangerouslySetInnerHTML={{ __html: html as string }}
        />
      )}
    </div>
  );
}
