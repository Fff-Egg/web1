import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { AnalysisRetryReason } from "../../shared/analysisRetry.js";
import { ArticleAnalysisDiagnostics } from "./ArticleAnalysisDiagnostics.js";

const reasons: Record<AnalysisRetryReason, string> = {
  output_limit: "출력 제한 보정 후에도 응답이 잘림", reading_held: "전체 읽기 복구 한도 도달",
  request_rejected: "API 요청 거절 · 모델/입력 설정 확인 필요", authentication: "API 인증/권한 오류",
  balance: "API 크레딧 소진·사용 한도 도달 (6시간마다 재확인)", rate_limit: "API 요청 속도 제한",
  overloaded: "API 서버 과부하 (15분 뒤 재시도)", transient: "일시적인 연결/처리 오류",
};
const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

export function AnalysisRetryPanel() {
  const status = useQuery({ queryKey: ["analysisRetryStatus"], queryFn: () => api.getAnalysisRetryStatus(), refetchInterval: 60_000 });
  const [confirmation, setConfirmation] = useState<number | "all" | null>(null);
  const [diagnosticArticleId, setDiagnosticArticleId] = useState<number | null>(null);
  const reset = useMutation({
    mutationFn: (id: number | "all") => api.resetAnalysisRetry(id === "all" ? undefined : id),
    onSuccess: async () => { setConfirmation(null); await status.refetch(); },
  });
  const s = status.data;
  return <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">자동 분석 재시도 관리</h2>
      <button type="button" onClick={() => void status.refetch()} disabled={status.isFetching}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">상태 새로고침</button>
    </div>
    <p className="text-xs leading-relaxed text-slate-500">반복 실패한 글은 자동 호출을 보류하며 본문과 완료된 요약은 보존합니다. 일시 오류는 30분·2시간 뒤 재시도하고 3회 안에 완료되지 않으면 보류합니다. 서버 중단도 시도 횟수에 포함합니다. 잘린 요약은 작은 구간으로 제한적으로 복구합니다. 조회·새로고침은 AI를 호출하지 않습니다.</p>
    {status.isPending && <p className="text-sm text-slate-500">재시도 상태를 불러오는 중…</p>}
    {status.error && <p className="text-sm text-red-600">재시도 상태를 불러오지 못했습니다.</p>}
    {s && <>
      {!s.persisted && <p className="text-xs text-amber-700">DB가 연결되지 않아 재시도 상태를 저장하지 않습니다.</p>}
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{[
        ["미분석 글", s.totalPending], ["분석 가능한 글", s.eligible], ["재시도 시간 대기", s.waiting], ["자동 재시도 보류", s.held],
      ].map(([label, value]) => <div key={label} className="rounded bg-slate-50 p-3">{label}<strong className="block text-lg">{Number(value).toLocaleString("ko-KR")}건</strong></div>)}</div>
      <p className="text-xs text-slate-500">분석 가능한 글도 위 절약 대기 시간에는 자동 실행을 기다립니다. 보류된 글은 분석을 마치기 전까지 다이제스트에 반영되지 않습니다.</p>
      {s.persisted && <BacklogCleanupSection onChanged={() => void status.refetch()} />}
      {s.globalPause && <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">전체 글 분석 대기: {reasons[s.globalPause.reason]} · {time(s.globalPause.until)}까지</p>}
      {s.items.length > 0 && <div className="max-h-80 overflow-auto"><table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-slate-100"><tr>{["글", "원인 / 상태", "시도", ""].map((label, i) => <th key={i} className="p-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{s.items.map(row => <tr key={row.articleId} className="border-b border-slate-100 align-top">
          <td className="p-2 max-w-xs break-words">{row.title || `글 #${row.articleId}`}<span className="block text-slate-400">#{row.articleId}</span></td>
          <td className="p-2">{reasons[row.reason]}<span className="block text-slate-500">{row.held ? "자동 재시도 보류" : row.nextRetryAt ? `${time(row.nextRetryAt)} 이후 재시도` : "대기 중"}</span></td>
          <td className="p-2 whitespace-nowrap">{row.attempts}회</td>
          <td className="p-2"><div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setDiagnosticArticleId(current => current === row.articleId ? null : row.articleId)}
              aria-expanded={diagnosticArticleId === row.articleId} className="rounded border border-slate-300 px-2 py-1 whitespace-nowrap">처리 내역</button>
            <button type="button" onClick={() => setConfirmation(row.articleId)} disabled={reset.isPending}
              className="rounded border border-slate-300 px-2 py-1 whitespace-nowrap disabled:opacity-50">재시도 허용</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>}
      {s.items.length > 0 && <p className="text-xs text-slate-400">보류·대기 글 중 최근 20건까지 표시합니다.</p>}
      {diagnosticArticleId !== null && <ArticleAnalysisDiagnostics key={diagnosticArticleId} articleId={diagnosticArticleId} />}
      {(s.held > 0 || s.waiting > 0 || s.globalPause) && <button type="button" onClick={() => setConfirmation("all")} disabled={reset.isPending}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">전체 대기·보류 해제</button>}
    </>}
    {confirmation !== null && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm space-y-2">
      <p>{confirmation === "all" ? "모든 글의" : `글 #${confirmation}의`} 재시도 제한과 전체 분석 대기를 해제합니다. 완료된 요약은 유지하며, 다음 분석 때 추가 API 비용이 발생할 수 있습니다. 오류 원인이나 API 잔액을 확인한 후 진행하세요.</p>
      <div className="flex gap-3"><button type="button" onClick={() => reset.mutate(confirmation)} disabled={reset.isPending}
        className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50">{reset.isPending ? "해제 중…" : "확인 · 다음 분석에서 재시도"}</button>
        <button type="button" onClick={() => setConfirmation(null)} disabled={reset.isPending}>취소</button></div>
    </div>}
    {reset.isSuccess && <p className="text-sm text-green-700">{reset.data.reset}건의 제한을 해제했습니다. 즉시 AI를 호출하지 않으며 다음 분석에서 이어갑니다.</p>}
    {reset.error && <p className="text-sm text-red-600">제한 해제에 실패했습니다. 상태를 새로고침해주세요.</p>}
  </section>;
}

const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 밀린 미분석 글 정리: move unanalyzed articles collected before a KST date to the trash
 * so only recent ones are analyzed (and billed). Preview and undo never call the AI.
 */
function BacklogCleanupSection({ onChanged }: { onChanged: () => void }) {
  const [date, setDate] = useState(kstToday);
  const [confirming, setConfirming] = useState(false);
  const preview = useQuery({ queryKey: ["backlogCleanupPreview", date], queryFn: () => api.previewBacklogCleanup(date),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date) });
  const last = useQuery({ queryKey: ["lastBacklogCleanup"], queryFn: () => api.getLastBacklogCleanup() });
  const done = async () => { setConfirming(false); await Promise.all([preview.refetch(), last.refetch()]); onChanged(); };
  const trash = useMutation({ mutationFn: () => api.trashUnanalyzedBefore(date), onSuccess: done });
  const undo = useMutation({ mutationFn: () => api.undoLastBacklogCleanup(), onSuccess: done });
  const p = preview.data;
  const n = (v: number) => v.toLocaleString("ko-KR");
  return <div className="rounded border border-slate-200 p-3 text-sm space-y-2">
    <p className="font-medium">밀린 미분석 글 정리</p>
    <p className="text-xs leading-relaxed text-slate-500">고른 날짜 0시(한국시간) <strong>이전에 수집된 미분석 글</strong>을 휴지통으로 옮겨
      자동 분석·다이제스트에서 뺍니다. 그 뒤에 들어온 글과 이미 분석된 글은 그대로입니다. AI를 호출하지 않으며, 같은 글은 다시
      수집되지 않습니다. 「휴지통 비우기」를 하면 본문까지 정리됩니다.</p>
    <label className="flex flex-wrap items-center gap-2 text-xs">기준일
      <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setConfirming(false); }}
        className="rounded border border-slate-300 px-2 py-1" />
      <span className="text-slate-400">(이 날짜 0시 이전 수집분이 대상)</span>
    </label>
    {preview.isFetching && <p className="text-xs text-slate-500">건수 확인 중…</p>}
    {p && <p className="text-xs">휴지통으로 옮길 글 <strong>{n(p.before)}건</strong> · 남아서 분석될 글 <strong>{n(p.kept)}건</strong></p>}
    {p && p.before > 0 && !confirming && <button type="button" onClick={() => setConfirming(true)}
      className="rounded border border-slate-300 px-3 py-1.5 text-sm">{n(p.before)}건 휴지통으로 옮기기</button>}
    {p && confirming && <div className="rounded border border-amber-200 bg-amber-50 p-2 space-y-2">
      <p className="text-xs">{date} 0시 이전에 수집된 미분석 글 {n(p.before)}건을 휴지통으로 옮깁니다. 이 글들은 분석·다이제스트에 들어가지
        않습니다. 바로 아래 「되돌리기」로 이번 정리를 취소할 수 있습니다.</p>
      <div className="flex gap-3"><button type="button" onClick={() => trash.mutate()} disabled={trash.isPending}
        className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50">{trash.isPending ? "옮기는 중…" : "확인 · 휴지통으로"}</button>
        <button type="button" onClick={() => setConfirming(false)} disabled={trash.isPending}>취소</button></div>
    </div>}
    {trash.isSuccess && <p className="text-xs text-green-700">{n(trash.data.trashed)}건을 휴지통으로 옮겼습니다.</p>}
    {trash.error && <p className="text-xs text-red-600">정리에 실패했습니다. 새로고침 후 다시 시도해 주세요.</p>}
    {last.data && <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      마지막 정리: {time(last.data.at)} · {last.data.date} 0시 이전 {n(last.data.trashed)}건
      <button type="button" onClick={() => undo.mutate()} disabled={undo.isPending}
        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-50">{undo.isPending ? "되돌리는 중…" : "되돌리기"}</button>
    </p>}
    {undo.isSuccess && <p className="text-xs text-green-700">{n(undo.data.restored)}건을 다시 분석 대기로 되돌렸습니다(다음 분석 때 비용이 듭니다).</p>}
  </div>;
}
