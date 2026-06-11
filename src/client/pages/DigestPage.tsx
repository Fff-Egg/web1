import { useEffect, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "../data/client.js";
import type { DigestSummary } from "../data/client.js";

const todayStr = () => new Date().toLocaleDateString("en-CA");

/**
 * In-page footnote jumps ([N] → #ref-N, back ↩ → #cite-N): scroll the target to
 * the middle of the viewport instead of the very top, then flash it. Other links
 * (external originals, and the telegram "?article=<id>" feed deep link) are left
 * untouched so they open normally — in a new tab.
 */
function onDigestClick(e: MouseEvent<HTMLElement>) {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
  if (!link) return;
  const href = link.getAttribute("href") || "";
  if (!href.startsWith("#")) return; // external / feed-deep-link open normally
  const id = decodeURIComponent(href.slice(1));
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("ref-flash");
  void el.offsetWidth; // reflow so the flash animation restarts on repeat clicks
  el.classList.add("ref-flash");
}

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
  const [fromDigests, setFromDigests] = useState(false);

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
    mutationFn: () => api.generateDigest({ start, end, title: title || undefined, fromDigests }),
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
  // Run the 21시 routine now (auto-digest + that window's feed sweep + memo).
  const runEvening = useMutation({
    mutationFn: () => api.runEveningDigest(),
    onSuccess: (res) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["feed"] });
      qc.invalidateQueries({ queryKey: ["feedCounts"] });
      if (res?.digest?.id) setSelectedId(res.digest.id);
    },
  });

  const digest = useQuery({
    queryKey: ["digest", selectedId],
    queryFn: () => api.getDigest(selectedId),
    enabled: selectedId !== undefined,
  });

  const html = digest.data ? marked.parse(digest.data.markdown) : "";

  const isAuto = (d: DigestSummary) => Boolean((d.meta as { auto?: boolean } | null | undefined)?.auto);
  const isCombined = (d: DigestSummary) =>
    (d.meta as { source?: string } | null | undefined)?.source === "digests";
  const optLabel = (d: DigestSummary) =>
    `${d.title ?? d.periodStart ?? ""}` +
    `${d.periodStart && d.periodEnd && d.periodStart !== d.periodEnd ? ` (${d.periodStart}~${d.periodEnd})` : ""}` +
    `${isCombined(d) ? " · 종합" : ""}`;
  const autos = (list.data ?? []).filter(isAuto);
  const manuals = (list.data ?? []).filter((d) => !isAuto(d));
  const selected = list.data?.find((d) => d.id === selectedId);

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
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={fromDigests}
              onChange={(e) => setFromDigests(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            저장 다이제스트로 종합(과거용)
          </label>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {generate.isPending ? "생성 중…" : "생성"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          기간은 <strong>21시 기준</strong>입니다. 예) 6/11 → 6/10 21시 ~ 6/11 21시. 과거 날짜는 피드가 비어 있으면
          그 기간의 저장된 다이제스트를 자동으로 종합합니다(위 체크로 강제 가능).
        </p>
        {generate.isSuccess && !generate.data && (
          <p className="mt-2 text-xs text-amber-600">이 기간에 종합할 피드·저장 다이제스트가 없어 생성하지 못했습니다.</p>
        )}
        {generate.error && (
          <p className="mt-2 text-xs text-red-600">{(generate.error as Error).message}</p>
        )}

        <div className="mt-3 border-t border-slate-100 pt-3">
          <button
            onClick={() => runEvening.mutate()}
            disabled={runEvening.isPending}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {runEvening.isPending ? "실행 중…" : "🕘 지금 21시 작업 실행"}
          </button>
          <span className="ml-2 text-xs text-slate-400">오늘 창(어제21시~오늘21시) 자동 다이제스트 + 그 구간 피드 정리</span>
          {runEvening.data && (
            <>
              <p className="mt-2 text-xs text-slate-600">
                {runEvening.data.digest
                  ? `오늘(${runEvening.data.date}) 실행 완료: 다이제스트 “${runEvening.data.digest.title}” 생성(${runEvening.data.digest.itemCount}건) · 피드 ${runEvening.data.digest.trashed}건 휴지통으로.`
                  : `오늘(${runEvening.data.date}) 구간(어제21시~오늘21시)에 다이제스트/정리할 글이 없습니다.`}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-slate-400">
                진단: 창 {runEvening.data.diag.start} ~ {runEvening.data.diag.end} · 창내 {runEvening.data.diag.rawInWindow}건 · 최근분석{" "}
                {String(runEvening.data.diag.latestCreatedAt)} · now {runEvening.data.diag.nowUtc}
              </p>
            </>
          )}
          {runEvening.error && (
            <p className="mt-2 text-xs text-red-600">{(runEvening.error as Error).message}</p>
          )}
        </div>
      </section>

      {/* Saved digests — auto (21시) and manual grouped separately */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">저장된 다이제스트:</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {(!list.data || list.data.length === 0) && <option value="">(없음)</option>}
          {autos.length > 0 && (
            <optgroup label="🤖 자동(21시)">
              {autos.map((d) => (
                <option key={d.id} value={d.id}>{optLabel(d)}</option>
              ))}
            </optgroup>
          )}
          {manuals.length > 0 && (
            <optgroup label="✍️ 수동">
              {manuals.map((d) => (
                <option key={d.id} value={d.id}>{optLabel(d)}</option>
              ))}
            </optgroup>
          )}
        </select>
        {selected && (
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs font-medium " +
              (isAuto(selected) ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600")
            }
          >
            {isAuto(selected) ? "자동(21시)" : "수동"}
            {isCombined(selected) ? " · 저장본 종합" : ""}
          </span>
        )}
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
          onClick={onDigestClick}
          dangerouslySetInnerHTML={{ __html: html as string }}
        />
      )}
    </div>
  );
}
