import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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
  const schedule = useQuery({ queryKey: ["digestSchedule"], queryFn: () => api.digestSchedule() });
  // Formatted run-hour labels ("07시" / "17시") from the server config — defaults
  // match the code defaults so labels don't flash while loading.
  const hh = (h: number) => `${String(h).padStart(2, "0")}시`;
  const midH = hh(schedule.data?.middayHour ?? 17);
  const evH = hh(schedule.data?.eveningHour ?? 7);
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
  // Run the midday 작업 now (낮분 다이제스트만 — sweep 없음). 슬롯 마감 전엔 거부.
  const runMidday = useMutation({
    mutationFn: () => api.runMiddayDigest(),
    onSuccess: (res) => {
      invalidate();
      if (res?.digest?.id) setSelectedId(res.digest.id);
    },
  });
  // Run the boundary routine now (auto-digest + that window's feed sweep + memo).
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

  // Memoized so the article's innerHTML reference is stable: a re-render (e.g.
  // closing the peek) must NOT re-set innerHTML, or it would wipe the yellow
  // marker we add to the footnote on jump.
  const html = useMemo(() => (digest.data ? (marked.parse(digest.data.markdown) as string) : ""), [digest.data]);

  const articleRef = useRef<HTMLElement | null>(null);
  // Per-ref memory of WHICH [N] occurrence the user last clicked, so the footnote
  // "↩" returns to that exact spot (the same [N] can appear many times; the stored
  // HTML only ids the first). Element id, e.g. "cite-3" or "cite-3-2". Reset per digest.
  const lastCite = useRef<Map<number, string>>(new Map());

  // Hover/tap peek for a citation [N] (title + source). JS-positioned so it sits
  // ABOVE the [N] and is CLAMPED to the viewport (never clipped at the right edge
  // on a phone). Non-interactive tooltip — clicking the [N] still jumps (yellow).
  type Peek = {
    text: string;
    citeId: string; // which occurrence it's showing for (dedupe repeat hovers)
    left: number;
    vert: { top: number } | { bottom: number };
    maxW: number;
  };
  const [peek, setPeek] = useState<Peek | null>(null);

  const openPeek = (cite: HTMLElement) => {
    const text = cite.getAttribute("data-tip") || "";
    if (!text) return;
    const rect = cite.getBoundingClientRect();
    const margin = 8;
    const maxW = Math.min(320, window.innerWidth - 2 * margin);
    // Clamp left so the card stays fully on screen even when [N] is at the right edge.
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - maxW));
    // Above the [N]; drop below only when it's too near the top to fit above.
    const estH = 110;
    const vert =
      rect.top >= estH + 8
        ? { bottom: Math.round(window.innerHeight - rect.top + 6) }
        : { top: Math.round(rect.bottom + 6) };
    setPeek({ text, citeId: cite.id, left: Math.round(left), vert, maxW });
  };

  /** Smooth-scroll to an element id, pulse it, keep it marked, remember it. */
  const jumpTo = (scope: HTMLElement, targetId: string) => {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    markActiveRef(scope, el);
    if (selectedId !== undefined) {
      try {
        sessionStorage.setItem(ACTIVE_REF_KEY, JSON.stringify({ digestId: selectedId, anchor: targetId }));
      } catch {
        /* storage unavailable — highlight just won't survive a remount */
      }
    }
    el.classList.remove("ref-flash");
    void el.offsetWidth; // reflow so the pulse animation restarts on repeat clicks
    el.classList.add("ref-flash");
  };

  /**
   * Citation interactions. Hovering/tapping a [N] shows its peek (title/source) in
   * place; CLICKING the [N] jumps to the footnote and leaves the yellow marker,
   * remembering which occurrence you came from so "↩" returns there. The footnote
   * "↩" (#cite-N) scrolls back. Other links open normally in a new tab.
   */
  const onDigestClick = (e: MouseEvent<HTMLElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#")) return; // external / feed-deep-link open normally
    e.preventDefault();
    const scope = articleRef.current ?? e.currentTarget;
    // Citation [N] → jump to footnote, remembering the clicked occurrence.
    const refM = href.match(/^#ref-(\d+)$/);
    if (refM) {
      const n = Number(refM[1]);
      const sup = link.closest<HTMLElement>("sup.cite");
      if (sup?.id) lastCite.current.set(n, sup.id);
      jumpTo(scope, `ref-${n}`);
    } else {
      // Back ↩ (#cite-N) → the exact occurrence clicked (fallback: first).
      const citeM = href.match(/^#cite-(\d+)$/);
      jumpTo(scope, citeM ? lastCite.current.get(Number(citeM[1])) ?? `cite-${citeM[1]}` : decodeURIComponent(href.slice(1)));
    }
    setPeek(null); // after the jump's DOM marking, so no re-render races it
  };

  // Hover (or first tap) over a [N] shows its peek; leaving it (mouse) hides it.
  const onCitePointerOver = (e: ReactPointerEvent<HTMLElement>) => {
    const cite = (e.target as HTMLElement).closest<HTMLElement>("sup.cite");
    if (!cite || !cite.id || peek?.citeId === cite.id) return;
    openPeek(cite);
  };
  const onCitePointerOut = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return; // touch: dismissed by click/scroll instead
    const cite = (e.target as HTMLElement).closest<HTMLElement>("sup.cite");
    const to = e.relatedTarget as HTMLElement | null;
    if (!cite || (to && cite.contains(to))) return; // still within the same [N]
    setPeek(null);
  };

  // Dismiss the peek on scroll / Escape / outside tap (mouse-leave handled above).
  useEffect(() => {
    if (!peek) return;
    const onScroll = () => setPeek(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPeek(null);
    };
    const onDown = (e: Event) => {
      if (!(e.target as HTMLElement).closest("sup.cite")) setPeek(null);
    };
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [peek]);

  // After a digest renders: (1) give every [N] occurrence a unique id so "↩" can
  // return to the one clicked (stored HTML only ids the first), (2) re-apply the
  // saved highlight so the last-jumped marker survives tab switches / remounts.
  useEffect(() => {
    const scope = articleRef.current;
    if (!scope || !digest.data || selectedId === undefined) return;
    lastCite.current.clear();
    const perN = new Map<number, number>();
    scope.querySelectorAll<HTMLElement>("sup.cite").forEach((sup) => {
      const m = sup
        .querySelector('a[href^="#ref-"]')
        ?.getAttribute("href")
        ?.match(/^#ref-(\d+)$/);
      if (!m) return;
      const n = Number(m[1]);
      const k = perN.get(n) ?? 0;
      perN.set(n, k + 1);
      sup.id = k === 0 ? `cite-${n}` : `cite-${n}-${k}`;
    });
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
  // Auto digests run twice a day; legacy autos (no slot in meta) were the boundary (evening) run.
  const slotLabel = (d: DigestSummary) =>
    (d.meta as { slot?: string } | null | undefined)?.slot === "midday" ? midH : evH;
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
          기간은 <strong>{evH} 기준</strong>입니다. 예) 6/11 → 6/10 {evH} ~ 6/11 {evH}. 과거 날짜는 피드가 비어 있으면
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
            {runMidday.isPending ? "실행 중…" : `🕑 지금 ${midH} 작업 실행`}
          </button>
          <span className="ml-2 text-xs text-slate-400">
            낮분({midH} 마감분) 다이제스트만 생성 · 피드 정리 없음 · {midH} 이후 보충용
          </span>
          {runMidday.data && (
            <p className="mt-2 text-xs text-slate-600">
              {runMidday.data.tooEarly
                ? `아직 ${midH}(KST)분이 다 안 모였습니다 — 지금 실행하면 낮분 창이 일찍 닫혀 이후 글이 누락되므로 실행하지 않았습니다.`
                : runMidday.data.digest
                  ? `${runMidday.data.date} 낮분 “${runMidday.data.digest.title}” 생성(${runMidday.data.digest.itemCount}건).`
                  : runMidday.data.existed
                    ? `${runMidday.data.date} 낮분이 이미 있습니다.`
                    : `${runMidday.data.date} 낮분 구간에 새 글이 없습니다.`}
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
            {runEvening.isPending ? "실행 중…" : `🕘 지금 ${evH} 작업 실행`}
          </button>
          <span className="ml-2 text-xs text-slate-400">
            낮분 보충 + 저녁분({midH}~{evH}) 다이제스트 + 하루 창 전체 피드 정리 · {evH} 이후 보충용
          </span>
          {runEvening.data && (
            <>
              <p className="mt-2 text-xs text-slate-600">
                {(() => {
                  const r = runEvening.data;
                  if (r.tooEarly)
                    return `아직 ${evH}(KST) 전입니다 — 지금 실행하면 저녁분이 일찍 확정되고 피드 정리도 당겨져 이후 글이 누락되므로 실행하지 않았습니다.`;
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

      {/* Saved digests — auto (boundary/midday) and manual grouped separately */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">저장된 다이제스트:</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : undefined)}
          className="min-w-0 max-w-full truncate rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {(!list.data || list.data.length === 0) && <option value="">(없음)</option>}
          {autos.length > 0 && (
            <optgroup label={`🤖 자동 (${midH}·${evH})`}>
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
          onPointerOver={onCitePointerOver}
          onPointerOut={onCitePointerOut}
          dangerouslySetInnerHTML={{ __html: html as string }}
        />
      )}

      {/* Citation peek — sits above the [N], clamped to the viewport. Non-interactive
          (clicks pass through to the number, which jumps). */}
      {peek && (
        <div
          style={{
            position: "fixed",
            left: peek.left,
            ...("top" in peek.vert ? { top: peek.vert.top } : { bottom: peek.vert.bottom }),
            maxWidth: peek.maxW,
            zIndex: 50,
            pointerEvents: "none",
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm not-italic leading-snug text-slate-700 shadow-lg"
        >
          {peek.text}
        </div>
      )}
    </div>
  );
}
