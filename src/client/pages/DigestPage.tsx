import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "../data/client.js";
import type { DigestSummary } from "../data/client.js";

const todayStr = () => new Date().toLocaleDateString("en-CA");

/** sessionStorage slot remembering the last-jumped footnote (per digest), so the
 *  highlight survives leaving this tab (Feed 등) and coming back. */
const ACTIVE_REF_KEY = "digest-active-ref";

/** Move the persistent highlight: only one .ref-active at a time per digest. */
function markActiveRef(scope: HTMLElement, el: HTMLElement) {
  scope.querySelectorAll(".ref-active").forEach((n) => n.classList.remove("ref-active"));
  el.classList.add("ref-active");
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
  // Run the 14시 작업 now (낮분 다이제스트만 — sweep 없음). 14시 전엔 거부.
  const runMidday = useMutation({
    mutationFn: () => api.runMiddayDigest(),
    onSuccess: (res) => {
      invalidate();
      if (res?.digest?.id) setSelectedId(res.digest.id);
    },
  });
  // Run the 21시 routine now (auto-digest + that window's feed sweep + memo).
  const runEvening = useMutation({
    mutationFn: () => api.runEveningDigest(),
    onSuccess: (res) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["feed"] });
      qc.invalidateQueries({ queryKey: ["feedCounts"] });
      qc.invalidateQueries({ queryKey: ["filterGuidance"] });
      const id = res?.evening?.id ?? res?.midday?.id;
      if (id) setSelectedId(id);
    },
  });
  // Tidy a past range's feed (no digest, no feedback signal).
  const sweep = useMutation({
    mutationFn: () => api.sweepFeedRange(start, end),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feed"] });
      qc.invalidateQueries({ queryKey: ["feedCounts"] });
    },
  });

  const digest = useQuery({
    queryKey: ["digest", selectedId],
    queryFn: () => api.getDigest(selectedId),
    enabled: selectedId !== undefined,
  });

  const html = digest.data ? marked.parse(digest.data.markdown) : "";

  const articleRef = useRef<HTMLElement | null>(null);

  /**
   * In-page footnote jumps ([N] → #ref-N, back ↩ → #cite-N): scroll the target
   * to the middle of the viewport, pulse it, and keep it marked (.ref-active)
   * until the next jump — "내가 몇 번이었지?"를 잃지 않게. Other links (external
   * originals, telegram "?article=<id>" deep link) open normally in a new tab.
   */
  const onDigestClick = (e: MouseEvent<HTMLElement>) => {
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
    markActiveRef(e.currentTarget, el);
    if (selectedId !== undefined) {
      try {
        sessionStorage.setItem(ACTIVE_REF_KEY, JSON.stringify({ digestId: selectedId, anchor: id }));
      } catch {
        /* storage unavailable — highlight just won't survive a remount */
      }
    }
    el.classList.remove("ref-flash");
    void el.offsetWidth; // reflow so the pulse animation restarts on repeat clicks
    el.classList.add("ref-flash");
  };

  // Coming back to this tab (or reselecting the digest) remounts the article —
  // re-apply the saved highlight so the last-jumped [N] is still marked.
  useEffect(() => {
    const scope = articleRef.current;
    if (!scope || !digest.data || selectedId === undefined) return;
    try {
      const raw = sessionStorage.getItem(ACTIVE_REF_KEY);
      const saved = raw ? (JSON.parse(raw) as { digestId?: number; anchor?: string }) : null;
      if (!saved?.anchor || saved.digestId !== selectedId) return;
      const el = document.getElementById(saved.anchor);
      if (el && scope.contains(el)) markActiveRef(scope, el);
    } catch {
      /* corrupt/unavailable storage — skip */
    }
  }, [digest.data, selectedId]);

  const isAuto = (d: DigestSummary) => Boolean((d.meta as { auto?: boolean } | null | undefined)?.auto);
  const isCombined = (d: DigestSummary) =>
    (d.meta as { source?: string } | null | undefined)?.source === "digests";
  // Auto digests run twice a day; legacy autos (no slot in meta) were the 21시 run.
  const slotLabel = (d: DigestSummary) =>
    ((d.meta as { slot?: string } | null | undefined)?.slot === "midday" ? "14시" : "21시");
  const optLabel = (d: DigestSummary) =>
    `${d.title ?? d.periodStart ?? ""}` +
    `${isAuto(d) ? ` · ${slotLabel(d)}` : ""}` +
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
            onClick={() => runMidday.mutate()}
            disabled={runMidday.isPending}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {runMidday.isPending ? "실행 중…" : "🕑 지금 14시 작업 실행"}
          </button>
          <span className="ml-2 text-xs text-slate-400">
            낮분(어제21시~오늘14시) 다이제스트만 생성 · 피드 정리 없음 · 14시 이후 보충용
          </span>
          {runMidday.data && (
            <p className="mt-2 text-xs text-slate-600">
              {runMidday.data.tooEarly
                ? `아직 14시(KST) 전입니다 — 지금 실행하면 낮분 창이 일찍 닫혀 이후 글이 누락되므로 실행하지 않았습니다.`
                : runMidday.data.digest
                  ? `오늘(${runMidday.data.date}) 낮분 “${runMidday.data.digest.title}” 생성(${runMidday.data.digest.itemCount}건).`
                  : runMidday.data.existed
                    ? `오늘(${runMidday.data.date}) 낮분이 이미 있습니다.`
                    : `오늘(${runMidday.data.date}) 낮분 구간에 새 글이 없습니다.`}
            </p>
          )}
          {runMidday.error && (
            <p className="mt-2 text-xs text-red-600">{(runMidday.error as Error).message}</p>
          )}
        </div>

        <div className="mt-3 border-t border-slate-100 pt-3">
          <button
            onClick={() => runEvening.mutate()}
            disabled={runEvening.isPending}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {runEvening.isPending ? "실행 중…" : "🕘 지금 21시 작업 실행"}
          </button>
          <span className="ml-2 text-xs text-slate-400">
            낮분 보충 + 저녁분(14~21시) 다이제스트 + 하루 창 전체 피드 정리 · 21시 이후 보충용
          </span>
          {runEvening.data && (
            <>
              <p className="mt-2 text-xs text-slate-600">
                {(() => {
                  const r = runEvening.data;
                  if (r.tooEarly)
                    return `아직 21시(KST) 전입니다 — 지금 실행하면 저녁분이 일찍 확정되고 피드 정리도 당겨져 이후 글이 누락되므로 실행하지 않았습니다.`;
                  const part = (
                    label: string,
                    gen: { title: string; itemCount: number } | null,
                    existed: boolean,
                  ) => (gen ? `${label} 생성(${gen.itemCount}건)` : existed ? `${label} 이미 있음` : `${label} 새 글 없음`);
                  return (
                    `오늘(${r.date}) 실행: ${part("낮분", r.midday, r.middayExisted)} · ` +
                    `${part("저녁분", r.evening, r.eveningExisted)} · 피드 ${r.swept}건 휴지통으로.`
                  );
                })()}
                {" "}
                {runEvening.data.memo &&
                  `학습 메모: ${
                    runEvening.data.memo.updated
                      ? `갱신됨 (신규 ${runEvening.data.memo.newCount} · 누적 ${runEvening.data.memo.total})`
                      : `변화 없음 (누적 ${runEvening.data.memo.total})`
                  }.`}
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

          <div className="mt-3">
            <button
              onClick={() => sweep.mutate()}
              disabled={sweep.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {sweep.isPending ? "정리 중…" : "🧹 이 기간 피드 정리"}
            </button>
            <span className="ml-2 text-xs text-slate-400">
              위 <strong>시작·종료일</strong> 구간 피드를 휴지통으로 (다이제스트 X · 학습신호 X · ⭐저장/텔레그램 유지)
            </span>
            {sweep.data && (
              <p className="mt-1 text-xs text-slate-600">{sweep.data.swept}건 휴지통으로 정리했습니다.</p>
            )}
            {sweep.error && (
              <p className="mt-1 text-xs text-red-600">{(sweep.error as Error).message}</p>
            )}
          </div>
        </div>
      </section>

      {/* Saved digests — auto (21시) and manual grouped separately */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">저장된 다이제스트:</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : undefined)}
          className="min-w-0 max-w-full truncate rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {(!list.data || list.data.length === 0) && <option value="">(없음)</option>}
          {autos.length > 0 && (
            <optgroup label="🤖 자동 (14시·21시)">
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
            {isAuto(selected) ? `자동 · ${slotLabel(selected)}` : "수동"}
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
          ref={articleRef}
          className="prose-digest rounded-lg border border-slate-200 bg-white p-5"
          onClick={onDigestClick}
          dangerouslySetInnerHTML={{ __html: html as string }}
        />
      )}
    </div>
  );
}
