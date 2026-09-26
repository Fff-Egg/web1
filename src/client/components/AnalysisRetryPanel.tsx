import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { AnalysisRetryReason } from "../../shared/analysisRetry.js";
import { ArticleAnalysisDiagnostics } from "./ArticleAnalysisDiagnostics.js";

const reasons: Record<AnalysisRetryReason, string> = {
  output_limit: "출력 제한 보정 후에도 응답이 잘림", reading_held: "전체 읽기 복구 한도 도달",
  request_rejected: "API 요청 거절 · 모델/입력 설정 확인 필요", authentication: "API 인증/권한 오류",
  balance: "API 잔액 부족", rate_limit: "API 요청 속도 제한", transient: "일시적인 연결/처리 오류",
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
