import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "../data/client.js";

/**
 * Daily Digest — pick a date and read that day's synthesized report. Each
 * referenced article keeps its source attribution + original link (rendered
 * from the markdown the digest generator produces).
 */
export function DigestPage() {
  const qc = useQueryClient();
  const dates = useQuery({ queryKey: ["digestDates"], queryFn: () => api.listDigestDates() });
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const generate = useMutation({
    mutationFn: () => api.generateDigest(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["digestDates"] });
      qc.invalidateQueries({ queryKey: ["digest"] });
      if (res?.date) setSelected(res.date);
    },
  });

  // Default to the newest date once loaded.
  useEffect(() => {
    if (!selected && dates.data && dates.data.length > 0) {
      setSelected(dates.data[0].date);
    }
  }, [dates.data, selected]);

  const digest = useQuery({
    queryKey: ["digest", selected],
    queryFn: () => api.getDigest(selected),
    enabled: dates.isSuccess,
  });

  const html = digest.data ? marked.parse(digest.data.markdown) : "";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500">날짜:</span>
        <select
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || undefined)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {dates.data?.length === 0 && <option value="">(다이제스트 없음)</option>}
          {dates.data?.map((d) => (
            <option key={d.date} value={d.date}>
              {d.date}
            </option>
          ))}
        </select>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {generate.isPending ? "생성 중…" : "오늘 다이제스트 생성"}
        </button>
        {generate.data && generate.data.itemCount === 0 && (
          <span className="text-xs text-slate-500">오늘 뽑힌 글이 없습니다.</span>
        )}
        {generate.error && (
          <span className="text-xs text-red-600">{(generate.error as Error).message}</span>
        )}
      </div>

      {dates.data && dates.data.length === 0 && (
        <p className="text-slate-500">
          아직 생성된 다이제스트가 없습니다. (매일 저녁 자동 생성되거나 수동 생성 가능)
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
