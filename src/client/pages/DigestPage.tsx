import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { DigestSummary } from "../data/client.js";
import { renderMarkdown } from "../markdown.js";

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

  // Manual generate runs in the background (long map-reduce > HTTP timeout); while
  // pending we poll the list and grab the new digest when it appears.
  const [genState, setGenState] = useState<"idle" | "pending" | "timeout">("idle");
  const genSnapshot = useRef<Set<number>>(new Set());

  // Default to the newest saved digest once loaded.
  useEffect(() => {
    if (selectedId === undefined && list.data && list.data.length > 0) {
      setSelectedId(list.data[0].id);
    }
  }, [list.data, selectedId]);

  // Keep the make-digest dates on the currently-OPEN window (창 = 만든 시각 기준;
  // 07시 경계 이후엔 다음날) UNLESS the user manually picks a date. So an untouched
  // manual digest is filed under the creation-moment window date — the server
  // recomputes it at generate time (see the mutation below), staying precise.
  const dateDirty = useRef(false);
  useEffect(() => {
    const cur = schedule.data?.today;
    if (!cur || dateDirty.current) return;
    setStart(cur);
    setEnd(cur);
  }, [schedule.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["digests"] });
    qc.invalidateQueries({ queryKey: ["digest"] });
  };

  const generate = useMutation({
    // Untouched date → omit it so the SERVER dates the digest by the creation moment
    // (KST calendar day, midnight rollover). Manually-picked date (past-date backfill) is sent explicitly.
    mutationFn: () =>
      api.generateDigest({
        start: dateDirty.current ? start : undefined,
        end: dateDirty.current ? end : undefined,
        title: title || undefined,
        fromDigests,
      }),
    onMutate: () => {
      genSnapshot.current = new Set((list.data ?? []).map((d) => d.id));
      setGenState("pending");
    },
    onError: () => setGenState("idle"),
  });

  // While a background generate is running, poll the list; when a digest we didn't
  // have before appears, select it. Give up after a few minutes (still logs server-side).
  useEffect(() => {
    if (genState !== "pending") return;
    qc.invalidateQueries({ queryKey: ["digests"] }); // check once right away (fast/small ones)
    const poll = setInterval(() => qc.invalidateQueries({ queryKey: ["digests"] }), 4000);
    const giveUp = setTimeout(() => setGenState("timeout"), 240_000);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [genState, qc]);
  useEffect(() => {
    if (genState !== "pending" || !list.data) return;
    const fresh = list.data.find((d) => !genSnapshot.current.has(d.id));
    if (fresh) {
      setSelectedId(fresh.id);
      setGenState("idle");
    }
  }, [list.data, genState]);
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
    onMutate: () => {
      genSnapshot.current = new Set((list.data ?? []).map((d) => d.id));
    },
    onSuccess: (res) => {
      invalidate();
      // 백그라운드 실행 — 새 다이제스트가 목록에 뜰 때까지 폴링(생성 버튼과 같은 방식).
      if (res?.started) setGenState("pending");
    },
  });
  // Run the boundary routine now (auto-digest + that window's feed sweep + memo).
  const runEvening = useMutation({
    mutationFn: () => api.runEveningDigest(),
    onMutate: () => {
      genSnapshot.current = new Set((list.data ?? []).map((d) => d.id));
    },
    onSuccess: (res) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["feed"] });
      qc.invalidateQueries({ queryKey: ["feedCounts"] });
      qc.invalidateQueries({ queryKey: ["filterGuidance"] });
      // 경계 루틴은 백그라운드로 돈다 — 결과(다이제스트·sweep·메모)는 폴링으로 반영.
      if (res?.started) setGenState("pending");
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

  // Memoized so the article's innerHTML reference is stable: a re-render (e.g. a
  // mutation settling) must NOT re-set innerHTML, or it would wipe the yellow
  // marker we add to the footnote on jump.
  const html = useMemo(() => (digest.data ? renderMarkdown(digest.data.markdown) : ""), [digest.data]);

  const articleRef = useRef<HTMLElement | null>(null);
  // Per-ref memory of WHICH [N] occurrence the user last clicked, so the footnote
  // "↩" returns to that exact spot (the same [N] can appear many times; the stored
  // HTML only ids the first). Element id, e.g. "cite-3" or "cite-3-2". Reset per digest.
  const lastCite = useRef<Map<number, string>>(new Map());

  /** Smooth-scroll to an element id, pulse it, keep it marked, remember it. */
  const jumpTo = (scope: HTMLElement, targetId: string) => {
    const el = document.getElementById(targetId);
    if (!el) return;
    // The 참조 원문 list is inside a collapsed <details>; expand it so a jump to a
    // ref (#ref-N fallback for link-less items) actually lands somewhere visible.
    el.closest("details")?.setAttribute("open", "");
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
   * Footnote interactions. Hovering a [N] shows its peek (CSS tooltip; a light tap
   * shows it on a phone). CLICKING the [N] jumps to the footnote and leaves the
   * yellow marker, remembering which occurrence so "↩" returns there. The footnote
   * "↩" (#cite-N) scrolls back. Other links open normally in a new tab.
   */
  const onDigestClick = (e: MouseEvent<HTMLElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#")) return; // external / feed-deep-link open normally
    e.preventDefault();
    const scope = articleRef.current ?? e.currentTarget;
    const refM = href.match(/^#ref-(\d+)$/);
    if (refM) {
      const n = Number(refM[1]);
      const sup = link.closest<HTMLElement>("sup.cite");
      if (sup?.id) lastCite.current.set(n, sup.id);
      jumpTo(scope, `ref-${n}`);
      return;
    }
    // Back ↩ (#cite-N) → the exact occurrence clicked (fallback: first).
    const citeM = href.match(/^#cite-(\d+)$/);
    jumpTo(scope, citeM ? lastCite.current.get(Number(citeM[1])) ?? `cite-${citeM[1]}` : decodeURIComponent(href.slice(1)));
  };

  // Keep the CSS hover tooltip on-screen: per [N], set --tip-maxw (capped to the
  // viewport) and --tip-shift (a horizontal offset that clamps the tooltip fully on
  // screen, so a [N] near the right edge no longer clips). rect.left depends only on
  // horizontal layout, so it stays valid across vertical scroll; re-run on resize.
  useEffect(() => {
    const scope = articleRef.current;
    if (!scope || !digest.data) return;
    const place = () => {
      const margin = 8;
      const vw = window.innerWidth;
      const maxW = Math.min(288, vw - 2 * margin); // 288px = 18rem
      scope.querySelectorAll<HTMLElement>("sup.cite[data-tip]").forEach((cite) => {
        const left = cite.getBoundingClientRect().left;
        const target = Math.max(margin, Math.min(left, vw - margin - maxW));
        cite.style.setProperty("--tip-maxw", `${maxW}px`);
        cite.style.setProperty("--tip-shift", `${Math.round(target - left)}px`);
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [digest.data, selectedId]);

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
  const isMidday = (d: DigestSummary) => (d.meta as { slot?: string } | null | undefined)?.slot === "midday";

  // ── Date navigator (◀ 날짜 ▶ + that day's slot chips) — replaces the one huge
  // dropdown, which stopped scaling once 2 autos/day piled up.
  const kstDayOf = (t: string | Date) =>
    new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  /**
   * 이 다이제스트가 어느 날짜 탭에 들어가나.
   *
   * - **자동본**: 창이 끝나는 날(periodEnd) = 라벨. 아침분·낮분이 그 날짜 탭을 이루고
   *   `tabSpan`이 설명하는 구간과 일치한다.
   * - **수동본**: **만든 날(KST)**. 8/23 오후에 [8/23 07시 ~ 8/24 07시] 창을 만들면
   *   periodEnd는 8/24지만 사용자는 "23일에 만든 것"으로 찾는다 — 라벨 날짜로 묶으면
   *   오늘 만든 게 내일 탭에 숨는다(실제 혼란 사례). 각 칩에 자기 구간이 병기되므로
   *   어느 기간을 종합했는지는 칩에서 바로 보인다.
   */
  const dateOf = (d: DigestSummary): string =>
    isAuto(d) ? (d.periodEnd ?? d.periodStart ?? kstDayOf(d.createdAt)) : kstDayOf(d.createdAt);
  const digestDates = useMemo(
    () => [...new Set((list.data ?? []).map(dateOf))].sort((a, b) => (a < b ? 1 : -1)),
    [list.data],
  );
  const [viewDate, setViewDate] = useState<string>("");
  // Default to the newest date once the list loads.
  useEffect(() => {
    if (!viewDate && digestDates.length > 0) setViewDate(digestDates[0]);
  }, [digestDates, viewDate]);
  // When the selection changes from elsewhere (new digest generated, 지금 실행),
  // follow it to its date — but only once per id, so browsing isn't fought.
  const syncedIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (selectedId === undefined || syncedIdRef.current === selectedId) return;
    syncedIdRef.current = selectedId;
    const sel = list.data?.find((d) => d.id === selectedId);
    if (sel) setViewDate(dateOf(sel));
  }, [selectedId, list.data]);

  const digestsOn = useMemo(() => {
    // Chronological within the date: 아침분(07시 생성) → 낮분(14시 생성) → 수동.
    const rank = (d: DigestSummary) => (isAuto(d) ? (isMidday(d) ? 1 : 0) : 2);
    return (list.data ?? [])
      .filter((d) => dateOf(d) === viewDate)
      .sort((a, b) => rank(a) - rank(b) || +new Date(a.createdAt) - +new Date(b.createdAt));
  }, [list.data, viewDate]);

  /** Jump to a date and auto-open its most recent digest (1-click browsing). */
  const gotoDate = (date: string) => {
    setViewDate(date);
    const on = (list.data ?? []).filter((d) => dateOf(d) === date);
    if (on.length > 0) {
      const best = on.reduce((a, b) => (+new Date(a.createdAt) >= +new Date(b.createdAt) ? a : b));
      syncedIdRef.current = best.id; // already on this date — don't re-snap
      setSelectedId(best.id);
    }
  };
  // digestDates is newest-first: older = first entry before viewDate, newer = last after.
  const olderDate = digestDates.find((d) => d < viewDate);
  const newerDate = [...digestDates].reverse().find((d) => d > viewDate);

  /**
   * 날짜 탭 하나가 덮는 실제 구간 — 자동 두 슬롯의 합.
   * 아침분(D) = [(D-1) M시, D H시), 낮분(D) = [D H시, D M시)  →  [(D-1) M시, D M시).
   * (M<H인 설정에서는 경계가 반대로 놓이므로 그 경우는 H 기준으로 표기한다.)
   */
  const tabSpan = (iso: string) => {
    const M = schedule.data?.middayHour ?? 17;
    const H = schedule.data?.eveningHour ?? 7;
    const [a, b] = M >= H ? [`${mdy(prevDay(iso))} ${midH}`, `${mdy(iso)} ${midH}`] : [`${mdy(prevDay(iso))} ${evH}`, `${mdy(iso)} ${evH}`];
    return `${a} ~ ${b}`;
  };

  /** 칩 하나가 실제로 종합한 구간(짧게). 자동은 슬롯 창, 수동은 고른 날짜 창. */
  const chipSpan = (d: DigestSummary) => {
    const M = schedule.data?.middayHour ?? 17;
    const H = schedule.data?.eveningHour ?? 7;
    const end = d.periodEnd ?? d.periodStart;
    if (!end) return "";
    if (isAuto(d)) {
      return isMidday(d)
        ? `${mdy(M >= H ? end : prevDay(end))} ${evH}~${midH}` //  낮분: [D H시, D M시)
        : `${mdy(prevDay(end))} ${midH}~${mdy(end)} ${evH}`; //   아침분: [(D-1) M시, D H시)
    }
    const st = d.periodStart ?? end;
    return `${mdy(prevDay(st))} ${evH}~${mdy(end)} ${evH}`;
  };

  const chipLabel = (d: DigestSummary) => {
    if (isAuto(d)) return isMidday(d) ? `☀️ 낮분 ${midH}` : `🌅 아침분 ${evH}`;
    const range =
      d.periodStart && d.periodEnd && d.periodStart !== d.periodEnd
        ? ` (${d.periodStart.slice(5)}~${d.periodEnd.slice(5)})`
        : "";
    // Manual digests carry their creation time — several untitled manuals on one
    // date are indistinguishable otherwise.
    const created = new Date(d.createdAt).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `✍️ ${d.title ?? "수동"}${range}${isCombined(d) ? " · 종합" : ""} · ${created}`;
  };

  // Show the ACTUAL time window the picked dates resolve to (date D = [(D-1) evH,
  // D evH)), so the boundary-hour mapping is obvious instead of having to pick
  // "tomorrow's" label for today's content.
  const shiftDay = (iso: string, by: number) => {
    const d = new Date(`${iso}T12:00:00+09:00`);
    d.setDate(d.getDate() + by);
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  };
  const mdy = (iso: string) => {
    const p = iso.split("-");
    return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso;
  };
  const prevDay = (iso: string) => shiftDay(iso, -1);
  const nextDay = (iso: string) => shiftDay(iso, 1);
  /** 선택 날짜 하나가 뜻하는 창을 "8/22 07시 ~ 8/23 07시"로. 날짜=끝나는 날 규칙. */
  const spanOf = (iso: string) => (iso ? `${mdy(prevDay(iso))} ${evH} ~ ${mdy(iso)} ${evH}` : "");
  const winFrom = start ? `${mdy(prevDay(start))} ${evH}` : "";
  const winTo = end ? `${mdy(end)} ${evH}` : "";
  const isLiveWindow = start === end && start === schedule.data?.currentWindowDate;
  // 빠른 선택. 07시 경계 루틴은 종합을 마친 창을 곧바로 sweep하므로, "오늘 모인 글"을
  // 보려면 아직 **열려 있는 창**을 골라야 한다. 매번 날짜를 손으로 계산하지 않게 버튼을 둔다.
  const liveDate = schedule.data?.currentWindowDate ?? nextDay(todayStr());
  const closedDate = schedule.data?.today ?? todayStr();
  const pick = (d: string) => {
    dateDirty.current = true;
    setStart(d);
    setEnd(d);
  };
  const quickBtn = "rounded border px-2 py-1 text-[11px] font-medium transition";

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
              onChange={(e) => {
                dateDirty.current = true;
                setStart(e.target.value);
              }}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
            {/* 날짜 하나가 어떤 구간을 뜻하는지 입력 바로 밑에 붙인다 — "23일"만 보면
                [22일 07시, 23일 07시)인지 [23일 07시, 24일 07시)인지 알 수 없다. */}
            <span className="mt-0.5 block text-[10px] tabular-nums text-slate-400">{spanOf(start)}</span>
          </label>
          <label className="text-xs text-slate-500">
            종료일
            <input
              type="date"
              value={end}
              onChange={(e) => {
                dateDirty.current = true;
                setEnd(e.target.value);
              }}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <span className="mt-0.5 block text-[10px] tabular-nums text-slate-400">{spanOf(end)}</span>
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
            disabled={generate.isPending || genState === "pending"}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {genState === "pending" ? "생성 중…" : "생성"}
          </button>
        </div>
        {/* 빠른 선택 — "오늘 모인 글"을 보려면 아직 열려 있는 창을 골라야 한다.
            경계 루틴이 종합을 마친 창은 곧바로 sweep되므로 닫힌 창은 대개 비어 있다. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400">빠른 선택:</span>
          <button
            type="button"
            onClick={() => pick(liveDate)}
            className={
              quickBtn +
              (start === liveDate && end === liveDate
                ? " border-emerald-500 bg-emerald-50 text-emerald-700"
                : " border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            오늘 모인 글 <span className="font-normal opacity-70">({spanOf(liveDate)} · 진행 중)</span>
          </button>
          <button
            type="button"
            onClick={() => pick(closedDate)}
            className={
              quickBtn +
              (start === closedDate && end === closedDate
                ? " border-slate-500 bg-slate-100 text-slate-700"
                : " border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            어제분 <span className="font-normal opacity-70">({spanOf(closedDate)} · 마감됨)</span>
          </button>
        </div>
        {winFrom && winTo && (
          <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
            🕒 실제 종합 기간: <strong>{winFrom} ~ {winTo}</strong>
            {isLiveWindow && <span className="ml-1 font-medium text-emerald-600">· 지금 열린 창(오늘 라이브)</span>}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">
          날짜는 <strong>{evH} 경계</strong> 기준이라 <strong>끝나는 날</strong>을 고릅니다 — 날짜 칸 아래의 실제 구간을 보세요.
          ⚠️ <strong>{evH} 경계 루틴은 종합을 마친 창을 곧바로 휴지통으로 정리</strong>하므로, 이미 마감된 날을 고르면
          피드가 비어 저장된 다이제스트로 대체 종합됩니다. <strong>오늘 모인 글로 만들려면 위 “오늘 모인 글”</strong>을 누르세요.
        </p>
        {genState === "pending" && (
          <p className="mt-2 text-xs text-blue-600">
            백그라운드에서 생성 중… 완성되면 자동으로 열립니다. (글이 많으면 1~2분 걸릴 수 있어요)
          </p>
        )}
        {genState === "timeout" && (
          <p className="mt-2 text-xs text-amber-600">
            생성이 오래 걸리거나 종합할 글이 없었을 수 있어요. 잠시 후 “저장된 다이제스트” 목록을 확인하세요.
          </p>
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
                : runMidday.data.existed
                  ? `${runMidday.data.date} 낮분이 이미 있습니다.`
                  : `${runMidday.data.date} 낮분 생성을 시작했습니다 — 백그라운드로 돌며 완료되면 아래 목록에 나타납니다(1~3분).`}
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
            아침분(어제 {midH}~오늘 {evH}) + 어제 낮분 보충 + 하루 창 전체 피드 정리 · {evH} 이후 보충용
          </span>
          {runEvening.data && (
            <>
              <p className="mt-2 text-xs text-slate-600">
                {runEvening.data.tooEarly
                  ? `아직 ${evH}(KST) 전입니다 — 지금 실행하면 아침분이 일찍 확정되고 피드 정리도 당겨져 이후 글이 누락되므로 실행하지 않았습니다.`
                  : `오늘(${runEvening.data.date}) 경계 루틴을 시작했습니다 — 학습 메모 · 낮분 보충 · 아침분 · 피드 정리를 ` +
                    `백그라운드로 처리합니다. 완료되면 아래 목록에 나타납니다(글이 많으면 몇 분 걸립니다).`}
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

      {/* Saved digests — date navigator: ◀ 날짜 ▶ + that day's slot chips. */}
      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-600">저장된 다이제스트</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => olderDate && gotoDate(olderDate)}
              disabled={!olderDate}
              title="이전 날짜"
              className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            >
              ◀
            </button>
            <input
              type="date"
              value={viewDate}
              onChange={(e) => e.target.value && gotoDate(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              onClick={() => newerDate && gotoDate(newerDate)}
              disabled={!newerDate}
              title="다음 날짜"
              className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            >
              ▶
            </button>
            {digestDates[0] && viewDate !== digestDates[0] && (
              <button
                onClick={() => gotoDate(digestDates[0])}
                className="ml-1 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                최신으로
              </button>
            )}
          </div>
          <span className="ml-auto text-xs text-slate-400">총 {list.data?.length ?? 0}건</span>
        </div>
        {/* 날짜 하나가 덮는 실제 구간 — "23일"만 봐서는 어느 구간인지 알 수 없다.
            자동 두 슬롯(아침분+낮분)이 [(D-1) M시, D M시)를 빈틈없이 덮는다. */}
        {viewDate && (
          <p className="mt-1 text-[11px] tabular-nums text-slate-400">
            자동 다이제스트가 덮는 구간: <strong className="font-medium text-slate-500">{tabSpan(viewDate)}</strong>
            <span className="ml-1 opacity-80">(아침분 {evH} 마감 + 낮분 {midH} 마감)</span>
            <span className="ml-1 opacity-80">· 수동본은 <strong className="font-medium">만든 날</strong>에 묶이며 칩마다 자기 구간 표시</span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {digestsOn.length === 0 && (
            <span className="text-sm text-slate-400">
              이 날짜의 다이제스트가 없습니다 — ◀ ▶ 로 이동하세요.
            </span>
          )}
          {digestsOn.map((d) => (
            <button
              key={d.id}
              onClick={() => {
                syncedIdRef.current = d.id;
                setSelectedId(d.id);
              }}
              className={
                "rounded-full border px-3 py-1 text-sm " +
                (selectedId === d.id
                  ? "border-slate-900 bg-slate-900 font-medium text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
              }
            >
              {chipLabel(d)}
              <span className="ml-1 text-[10px] font-normal tabular-nums opacity-70">{chipSpan(d)}</span>
            </button>
          ))}
          {selectedId !== undefined && (
            <button
              onClick={() => remove.mutate(selectedId)}
              className="ml-auto shrink-0 text-xs text-slate-400 hover:text-red-600"
            >
              🗑 휴지통으로
            </button>
          )}
        </div>
      </section>

      {list.data && list.data.length === 0 && (
        <p className="text-slate-500">
          저장된 다이제스트가 없습니다. 위에서 기간을 정해 “생성”을 누르세요.
        </p>
      )}
      {digest.isLoading && <p className="text-slate-500">로딩…</p>}
      {digest.error && <p className="text-red-600">{(digest.error as Error).message}</p>}

      {digest.data && <ModelBadge meta={digest.data.meta} />}
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

/**
 * 이 리포트를 **실제로 어느 모델이 만들었는지** 한 줄로 보여준다.
 * 설정 모델이 실패해 폴백이 돌면 결과물의 성격이 달라지므로(추론형 vs 경량) 숨기지 않는다.
 * meta.models는 2026-08 이후 생성분에만 있다 — 옛 다이제스트는 meta.model만 표시.
 */
function ModelBadge({ meta }: { meta: unknown }) {
  type StageTrace = {
    configured?: string;
    planned?: string;
    used?: string[];
    attempts?: number;
    retries?: number;
    fallbacks?: number;
    failures?: number;
  };
  const m = meta as
    | {
        model?: string;
        models?: {
          version?: number;
          primary?: string;
          used?: string[];
          fallbacks?: number;
          failures?: number;
          stages?: { map?: StageTrace; final?: StageTrace };
        };
      }
    | null
    | undefined;
  const t = m?.models;
  const primary = t?.primary ?? m?.model;
  if (!primary) return null;

  // v2: intentional Flash map → Pro final is not a fallback. Report each stage
  // separately, and warn only when the FINAL Pro stage actually fell back.
  if (t?.version === 2 && t.stages?.final) {
    const map = t.stages.map;
    const final = t.stages.final;
    const mapRan = (map?.attempts ?? 0) > 0;
    const mapUsed = mapRan ? map?.used?.join(" + ") || map?.planned || "알 수 없음" : "원문 직접 전달";
    const finalUsed = final.used?.join(" + ") || final.planned || primary;
    const finalFallback = (final.fallbacks ?? 0) > 0;
    const failed = (map?.failures ?? 0) + (final.failures ?? 0);
    return (
      <div
        className={
          "mb-2 rounded px-2.5 py-2 text-[11px] leading-relaxed " +
          (finalFallback || failed > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800")
        }
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>{finalFallback ? "⚠️" : "✓"}</span>
          <span>자료 정리</span>
          <span className="rounded bg-white/80 px-1.5 py-0.5 font-mono font-medium">{mapUsed}</span>
          <span aria-hidden="true">→</span>
          <span>최종 연결·작성</span>
          <span className="rounded bg-white/80 px-1.5 py-0.5 font-mono font-semibold">{finalUsed}</span>
        </div>
        {!mapRan && map?.planned && (
          <p className="mt-1 opacity-75">글이 적어 묶음 압축 없이 원문을 최종 모델에 직접 전달했습니다.</p>
        )}
        {(final.retries ?? 0) > 0 && !finalFallback && (
          <p className="mt-1">최종 모델 첫 시도 실패 후 같은 모델 재시도로 성공했습니다.</p>
        )}
        {finalFallback && (
          <p className="mt-1">
            설정한 최종 모델 <span className="font-mono">{final.planned ?? primary}</span>이(가) 두 번 실패해 최후 수단으로
            자료 정리 모델이 최종 작성했습니다.
          </p>
        )}
        {failed > 0 && <p className="mt-1">끝내 실패한 자료 묶음 <strong>{failed}개</strong>는 내용이 빠졌습니다.</p>}
      </div>
    );
  }

  // 구버전(추적 정보 없음) — 설정 모델만 표시.
  if (!t || !Array.isArray(t.used) || t.used.length === 0) {
    return (
      <p className="mb-2 text-[11px] text-slate-400">
        모델 <span className="font-mono">{primary}</span>
      </p>
    );
  }

  const fellBack = (t.fallbacks ?? 0) > 0;
  const failed = t.failures ?? 0;
  return (
    <div
      className={
        "mb-2 rounded px-2.5 py-1.5 text-[11px] " +
        (fellBack || failed > 0 ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500")
      }
    >
      {fellBack ? "⚠️ " : "✓ "}
      모델 <span className="font-mono font-medium">{t.used.join(" + ")}</span>
      {fellBack && (
        <>
          {" "}
          — 설정 모델 <span className="font-mono">{primary}</span>이(가) 실패해 <strong>{t.fallbacks}개 호출을 폴백 모델로</strong>{" "}
          대체했습니다.
        </>
      )}
      {failed > 0 && <> · 끝내 실패한 묶음 <strong>{failed}개</strong>는 내용이 빠졌습니다.</>}
      {!fellBack && failed === 0 && " — 설정 모델로 전부 생성"}
    </div>
  );
}
