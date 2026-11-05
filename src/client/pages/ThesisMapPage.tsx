import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { ThreadRow, SignalRow, Verdict, Tier } from "../data/client.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  support: "강화", weaken: "약화", refute: "반증", neutral: "중립",
};
const VERDICT_STYLE: Record<Verdict, string> = {
  support: "bg-green-100 text-green-700",
  weaken: "bg-amber-100 text-amber-700",
  refute: "bg-red-100 text-red-700",
  neutral: "bg-slate-100 text-slate-600",
};
const TIER_LABEL: Record<Tier, string> = {
  confirmed: "확정", mgmt: "경영진주장", inference: "추론", speculation: "추측",
};

function fmtDate(d?: string | Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** 7-day net momentum (강화 − 약화 − 반증) → arrow. */
function trendArrow(c: Record<Verdict, number>): { sym: string; cls: string } {
  const net = c.support - c.weaken - c.refute;
  if (net > 0) return { sym: "▲", cls: "text-green-600" };
  if (net < 0) return { sym: "▼", cls: "text-red-600" };
  return { sym: "—", cls: "text-slate-400" };
}

/**
 * 논지 지도(Thesis Map) — track investment theses (threads) as system-aggregated
 * signals, not a feed to scroll. Refuting signals surface at the top in red.
 * Signals are written automatically by the 1st-pass analyzer.
 */
export function ThesisMapPage() {
  const qc = useQueryClient();
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api.listThreads(false) });
  const inbox = useQuery({ queryKey: ["thesisInbox"], queryFn: () => api.thesisInbox() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["threads"] });
    qc.invalidateQueries({ queryKey: ["thesisInbox"] });
  };

  const seed = useMutation({ mutationFn: () => api.seedThreads(), onSuccess: invalidate });

  const [adding, setAdding] = useState(false);
  const empty = threads.data && threads.data.length === 0;

  return (
    <div className="space-y-5">
      <p className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
        내가 추적하는 <strong>투자 논지(스레드)</strong>를 신호로 모읍니다. 1차 분석이 글을 읽을 때 각 논지를
        <span className="mx-1 rounded bg-green-100 px-1 text-green-700">강화</span>/
        <span className="mx-1 rounded bg-amber-100 px-1 text-amber-700">약화</span>/
        <span className="mx-1 rounded bg-red-100 px-1 text-red-700">반증</span>하는지 자동 기록합니다.
        신뢰도는 LLM이 아니라 <strong>신호 집계</strong>로 봅니다. <strong className="text-red-600">반증</strong> 신호는 맨 위에 빨갛게 뜹니다.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setAdding((v) => !v)} className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
          {adding ? "닫기" : "+ 새 논지"}
        </button>
        {empty && (
          <button onClick={() => seed.mutate()} disabled={seed.isPending} className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50">
            A~E 기본 논지 시딩
          </button>
        )}
        <span className="text-xs text-slate-400">{threads.data ? `${threads.data.length}개 논지` : "…"}</span>
      </div>

      {adding && <ThreadForm onDone={() => { setAdding(false); invalidate(); }} />}

      {/* 신규 논지 후보 인박스 */}
      {inbox.data && inbox.data.length > 0 && (
        <InboxSection inbox={inbox.data} threads={threads.data ?? []} onChange={invalidate} />
      )}

      {empty && !adding && (
        <p className="text-sm text-slate-400">아직 논지가 없습니다. “A~E 기본 논지 시딩” 또는 “+ 새 논지”로 시작하세요.</p>
      )}

      <ul className="space-y-3">
        {threads.data?.map((t) => (
          <ThreadCard key={t.id} thread={t} onChange={invalidate} />
        ))}
      </ul>
    </div>
  );
}

function ThreadForm({ thread, onDone }: { thread?: ThreadRow; onDone: () => void }) {
  const [name, setName] = useState(thread?.name ?? "");
  const [code, setCode] = useState(thread?.code ?? "");
  const [thesis, setThesis] = useState(thread?.thesis ?? "");
  const [context, setContext] = useState(thread?.context ?? "");
  const save = useMutation({
    mutationFn: () =>
      thread
        ? api.updateThread({ id: thread.id, name, code: code || null, thesis: thesis || null, context: context || null })
        : api.createThread({ name, code: code || undefined, thesis: thesis || undefined, context: context || undefined }).then(() => {}),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-3">
      <div className="flex gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="코드(A)" className="w-20 rounded border border-slate-300 px-2 py-1 text-sm" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="논지 이름 (예: HBM / DRAM)" className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm" />
      </div>
      <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="한 줄 명제" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      <textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="배경 메모(선택)" rows={2} className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      <div className="flex gap-2">
        <button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
          {thread ? "저장" : "추가"}
        </button>
        <button onClick={onDone} className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-600">취소</button>
      </div>
    </div>
  );
}

function ThreadCard({ thread, onChange }: { thread: ThreadRow; onChange: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const signals = useQuery({
    queryKey: ["threadSignals", thread.id],
    queryFn: () => api.threadSignals(thread.id),
    enabled: open,
  });
  const archive = useMutation({ mutationFn: () => api.setThreadArchived(thread.id, true), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => api.removeThread(thread.id), onSuccess: onChange });

  const refute30 = thread.c30.refute;
  const arrow = trendArrow(thread.c7);

  if (editing) {
    return <ThreadForm thread={thread} onDone={() => { setEditing(false); onChange(); }} />;
  }

  return (
    <li className={"rounded-lg border bg-white p-4 " + (refute30 > 0 ? "border-red-300" : "border-slate-200")}>
      {refute30 > 0 && (
        <div className="mb-2 rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
          ⚠ 최근 30일 반증 신호 {refute30}건 — 논지 점검 필요
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {thread.code && <span className="rounded bg-slate-900 px-1.5 py-0.5 text-xs font-bold text-white">{thread.code}</span>}
            <h3 className="truncate font-semibold text-slate-900">{thread.name}</h3>
            <span className={"text-sm " + arrow.cls}>{arrow.sym}</span>
          </div>
          {thread.thesis && <p className="mt-0.5 text-sm text-slate-600">{thread.thesis}</p>}
        </div>
        <div className="flex shrink-0 gap-2 text-xs text-slate-400">
          <button onClick={() => setEditing(true)} className="hover:text-slate-700">수정</button>
          <button onClick={() => archive.mutate()} className="hover:text-slate-700">보관</button>
          <button onClick={() => { if (confirm(`'${thread.name}' 논지와 신호를 삭제할까요?`)) remove.mutate(); }} className="hover:text-red-600">삭제</button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-slate-400">최근 7일</span>
        {(["support", "weaken", "refute", "neutral"] as Verdict[]).map((v) => (
          thread.c7[v] > 0 ? (
            <span key={v} className={"rounded px-1.5 py-0.5 font-medium " + VERDICT_STYLE[v]}>{VERDICT_LABEL[v]} {thread.c7[v]}</span>
          ) : null
        ))}
        {thread.c7.support + thread.c7.weaken + thread.c7.refute + thread.c7.neutral === 0 && <span className="text-slate-400">신호 없음</span>}
        <span className="ml-auto text-slate-400">총 {thread.total} · {thread.lastSignalAt ? `최근 ${fmtDate(thread.lastSignalAt)}` : "신호 없음"}</span>
      </div>

      <button onClick={() => setOpen((v) => !v)} className="mt-2 text-xs font-medium text-blue-600 hover:underline">
        {open ? "▾ 신호 접기" : "▸ 신호 보기"}
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {signals.isLoading && <li className="text-xs text-slate-400">불러오는 중…</li>}
          {signals.data && signals.data.length === 0 && <li className="text-xs text-slate-400">아직 신호가 없습니다.</li>}
          {[...(signals.data ?? [])]
            .sort((a, b) => (a.verdict === "refute" ? -1 : 0) - (b.verdict === "refute" ? -1 : 0))
            .map((s) => <SignalItem key={s.id} signal={s} onChange={() => qc.invalidateQueries({ queryKey: ["threadSignals", thread.id] })} />)}
        </ul>
      )}
    </li>
  );
}

/** Title → original link. Telegram has no public URL, so it deep-links into the
 *  보관함 (?article=<id>) — the same rule as the digest's citeHref on the server. */
function SignalLink({ signal: s }: { signal: SignalRow }) {
  const href = s.url ?? (s.provider === "telegram" ? `?article=${s.articleId}` : null);
  if (!href) return <span className="truncate text-slate-500">{s.title ?? "(제목 없음)"}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="truncate text-blue-600 hover:underline">
      {s.title ?? "(제목 없음)"} ↗
    </a>
  );
}

function SignalItem({ signal: s, onChange }: { signal: SignalRow; onChange?: () => void }) {
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissSignal(s.id),
    onSuccess: () => { onChange?.(); qc.invalidateQueries({ queryKey: ["threads"] }); },
  });
  return (
    <li className="rounded border border-slate-100 bg-slate-50 p-2">
      <div className="flex items-center gap-1.5">
        <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + VERDICT_STYLE[s.verdict]}>{VERDICT_LABEL[s.verdict]}</span>
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">{TIER_LABEL[s.tier]}</span>
        <span className="ml-auto text-xs text-slate-400">{fmtDate(s.createdAt)}</span>
      </div>
      {s.note && <p className="mt-1 text-sm text-slate-700">{s.note}</p>}
      <div className="mt-1 flex items-center gap-2 text-xs">
        <SignalLink signal={s} />
        <span className="shrink-0 text-slate-400">{s.sourceLabel ?? s.provider}</span>
        <button onClick={() => dismiss.mutate()} className="ml-auto shrink-0 text-slate-300 hover:text-red-600">신호 삭제</button>
      </div>
    </li>
  );
}

function InboxSection({ inbox, threads, onChange }: { inbox: SignalRow[]; threads: ThreadRow[]; onChange: () => void }) {
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h3 className="mb-2 text-sm font-semibold text-amber-800">새 논지 후보 ({inbox.length})</h3>
      <p className="mb-2 text-xs text-amber-700">어느 논지에도 안 맞지만 추적할 가치가 있는 신호입니다. 기존 논지에 붙이거나 새 논지로 승격하세요.</p>
      <ul className="space-y-2">
        {inbox.map((s) => <CandidateItem key={s.id} signal={s} threads={threads} onChange={onChange} />)}
      </ul>
    </section>
  );
}

function CandidateItem({ signal: s, threads, onChange }: { signal: SignalRow; threads: ThreadRow[]; onChange: () => void }) {
  const [assignTo, setAssignTo] = useState<number | "">("");
  const assign = useMutation({ mutationFn: (threadId: number) => api.assignSignal(s.id, threadId), onSuccess: onChange });
  const promote = useMutation({ mutationFn: () => api.promoteSignal(s.id, { name: s.candidate ?? undefined }), onSuccess: onChange });
  const dismiss = useMutation({ mutationFn: () => api.dismissSignal(s.id), onSuccess: onChange });
  return (
    <li className="rounded border border-amber-100 bg-white p-2">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-800">{s.candidate ?? "새 논지"}</span>
        <span className={"rounded px-1.5 py-0.5 text-xs font-medium " + VERDICT_STYLE[s.verdict]}>{VERDICT_LABEL[s.verdict]}</span>
        <span className="ml-auto text-xs text-slate-400">{fmtDate(s.createdAt)}</span>
      </div>
      {s.note && <p className="mt-1 text-sm text-slate-700">{s.note}</p>}
      <div className="mt-1 text-xs">
        <SignalLink signal={s} />
        <span className="ml-2 text-slate-400">{s.sourceLabel ?? s.provider}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => promote.mutate()} disabled={promote.isPending} className="rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50">새 논지로 승격</button>
        {threads.length > 0 && (
          <>
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value ? Number(e.target.value) : "")} className="rounded border border-slate-300 px-1.5 py-0.5 text-xs">
              <option value="">기존 논지에 붙이기…</option>
              {threads.map((t) => <option key={t.id} value={t.id}>{t.code ? `${t.code} · ` : ""}{t.name}</option>)}
            </select>
            {assignTo !== "" && (
              <button onClick={() => assign.mutate(assignTo)} className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">붙이기</button>
            )}
          </>
        )}
        <button onClick={() => dismiss.mutate()} className="ml-auto text-xs text-slate-400 hover:text-red-600">버리기</button>
      </div>
    </li>
  );
}
