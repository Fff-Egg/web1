import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { discountedFlashEstimate, LLM_STAGE_LABELS, usageFailureLabel, usageKstDay } from "../../shared/llmUsageView.js";

const count = (n: number | null) => n === null ? "미수신" : n.toLocaleString("ko-KR");
const hour = (n: number) => `${String(n).padStart(2, "0")}시`;
const minute = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export function LlmUsagePanel() {
  const queryClient = useQueryClient();
  const [day, setDay] = useState("today");
  const [retryArticleId, setRetryArticleId] = useState<number | null>(null);
  const retry = useMutation({
    mutationFn: (articleId: number) => api.runArticleAnalysis(articleId),
    retry: false,
    onSettled: (_data, _error, articleId) => {
      setRetryArticleId(null);
      for (const queryKey of [["llmUsage"], ["analysisRetryStatus"], ["pending"], ["feed"], ["feedCounts"], ["feedItem", articleId]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  const usage = useQuery({ queryKey: ["llmUsage"], queryFn: () => api.getLlmUsage(), refetchInterval: 60_000 });
  const schedule = useQuery({ queryKey: ["runtimeSchedule"], queryFn: () => api.getRuntimeSchedule(), refetchInterval: 60_000 });
  const today = usageKstDay(usage.data?.generatedAt ?? new Date().toISOString());
  const selectedDay = day === "today" ? today : day;
  const rows = (usage.data?.rows ?? []).filter(row => !selectedDay || row.day === selectedDay);
  const failures = (usage.data?.failureGroups ?? []).filter(row => !selectedDay || row.day === selectedDay);
  const repeated = usage.data?.repeatedArticles ?? [];
  const days = [...new Set((usage.data?.rows ?? []).map(row => row.day))].filter(d => d !== today).sort().reverse();
  const totals = rows.reduce((sum, row) => {
    const estimate = discountedFlashEstimate(row);
    return { requests: sum.requests + row.requests, output: sum.output + (row.outputTokens ?? 0),
      outputKnown: sum.outputKnown + row.outputKnown, unknown: sum.unknown + row.unknownUsage,
      cost: sum.cost + (estimate?.usd ?? 0), costRequests: sum.costRequests + (estimate?.requests ?? 0) };
  }, { requests: 0, output: 0, outputKnown: 0, unknown: 0, cost: 0, costRequests: 0 });
  const s = schedule.data;
  return <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">API 사용량과 실행 시간</h2>
      <button type="button" onClick={() => { void usage.refetch(); void schedule.refetch(); }}
        disabled={usage.isFetching || schedule.isFetching}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">새로고침</button>
    </div>
    {s && <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
      <p className="font-medium">현재 서버 적용 시간 · 한국시간</p>
      <p>아침 보고서 {hour(s.digestHour)} · 낮 보고서 {hour(s.middayHour)}
        <span className="ml-2 text-xs text-slate-500">{s.digestHourSource === "railway" ? "서버 설정" : "기본값"} / {s.middayHourSource === "railway" ? "서버 설정" : "기본값"}</span></p>
      {!s.automaticEnabled && <p className="text-amber-700">자동 실행이 꺼져 있습니다.</p>}
      <p>글 자동 분석 절약 대기: <strong>{s.peakAvoidanceEnabled ? "켜짐" : "꺼짐"}</strong>
        {s.peakAvoidanceEnabled && ` · 매일 ${s.pauseWindows.map(w => `${minute(w.startMinute)}~${minute(w.endMinute)}`).join(" · ")}`}</p>
      {s.peakAvoidanceEnabled && <p className="text-xs text-slate-500">{s.resumeHours.map(hour).join("·")}에 대기 글 분석을 재개합니다. 수집은 계속되며 수동 실행에는 이 대기 규칙이 적용되지 않습니다. 현재 앱은 주말에도 같은 시간에 대기합니다.</p>}
      {s.automaticEnabled && s.analysisDeferred && <p className="text-amber-700">현재는 글 자동 분석 대기 시간입니다.</p>}
    </div>}
    {schedule.error && <p className="text-sm text-red-600">서버 실행 시간을 불러오지 못했습니다. 새로고침해주세요.</p>}
    <p className="text-xs text-slate-500">이 기능 배포 이후에 기록한 최근 7일입니다. 조회·새로고침은 AI를 호출하지 않습니다. 기록 시도는 성공·실패를 모두 포함하며, 저장된 요약을 재사용해 API를 호출하지 않은 경우는 제외합니다.</p>
    {usage.isPending && <p className="text-sm text-slate-500">사용량을 불러오는 중…</p>}
    {usage.error && <p className="text-sm text-red-600">사용량 기록을 불러오지 못했습니다. 새로고침해주세요.</p>}
    {usage.data && <>
      {!usage.data.persisted && <p className="text-xs text-amber-700">DB가 연결되지 않아 사용량을 저장하지 않습니다.</p>}
      <label className="flex items-center gap-2 text-sm">기간
        <select value={day} onChange={event => setDay(event.target.value)} className="rounded border border-slate-300 px-2 py-1">
          <option value="today">오늘 ({today} · 진행 중)</option><option value="">최근 7일 전체</option>{days.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-500">{selectedDay || "최근 7일"} 합계 · 수정 전에 발생한 요청과 비용도 포함합니다.</p>
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div className="rounded bg-slate-50 p-3">기록된 요청<strong className="block text-lg">{count(totals.requests)}회</strong></div>
        <div className="rounded bg-slate-50 p-3">확인된 출력 토큰<strong className="block text-lg">{totals.outputKnown ? count(totals.output) : "미수신"}</strong><span className="text-xs text-slate-500">출력 수신 {count(totals.outputKnown)} / {count(totals.requests)}회</span></div>
        <div className="rounded bg-slate-50 p-3">할인 단가 기준 추정<strong className="block text-lg">{totals.costRequests ? `$${totals.cost.toFixed(4)}` : "계산할 기록 없음"}</strong><span className="text-xs text-slate-500">계산 가능 {count(totals.costRequests)} / {count(totals.requests)}회</span></div>
      </div>
      {totals.unknown > 0 && <p className="text-xs text-amber-700">입력 또는 출력 사용량을 받지 못한 요청이 {count(totals.unknown)}회 있습니다. 연결 중단 등으로 제공자가 사용량을 보내지 않은 경우이며 비용이 0이라는 뜻은 아닙니다.</p>}
      {rows.length ? <div className="max-h-[30rem] overflow-auto">
        <table className="w-full text-xs whitespace-nowrap text-left">
          <thead className="sticky top-0 bg-slate-100"><tr>{["날짜", "작업 / 모델", "Thinking", "요청 / 실패", "입력 적중 / 미적중", "출력 토큰", "할인 기준 추정"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => {
            const estimate = discountedFlashEstimate(row);
            return <tr key={`${row.day}-${row.stage}-${row.model}-${row.thinking}-${i}`} className="border-b border-slate-100 align-top">
              <td className="p-2">{row.day.slice(5)}</td>
              <td className="p-2">{LLM_STAGE_LABELS[row.stage] ?? row.stage}<span className="block text-[10px] text-slate-500">{row.model}</span></td>
              <td className="p-2">{row.thinking === "enabled" ? "ON" : row.thinking === "disabled" ? "OFF" : "미확인"}</td>
              <td className="p-2 text-right">{count(row.requests)} / <span className={row.failed ? "text-red-600" : ""}>{count(row.failed)}</span></td>
              <td className="p-2 text-right">{count(row.cacheHitTokens)} / {count(row.cacheMissTokens)}<span className="block text-[10px] text-slate-500">수신 {row.cacheHitKnown} / {row.cacheMissKnown}회</span></td>
              <td className="p-2 text-right">{count(row.outputTokens)}<span className="block text-[10px] text-slate-500">수신 {row.outputKnown}회{row.reasoningKnown > 0 && ` · 확인된 생각 ${count(row.reasoningTokens)} (${row.reasoningKnown}회)`}</span></td>
              <td className="p-2 text-right">{estimate ? `$${estimate.usd.toFixed(4)}` : "미계산"}{estimate && <span className="block text-[10px] text-slate-500">{estimate.requests}회분</span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="text-sm text-slate-500">아직 기록된 API 요청이 없습니다. 다음 분석부터 표시됩니다.</p>}
      {failures.length > 0 && <details className="rounded border border-amber-200 bg-amber-50/40 p-3" open>
        <summary className="cursor-pointer text-sm font-medium">선택 기간의 실패 원인 · 실패한 응답에도 토큰 비용이 발생할 수 있습니다</summary>
        <div className="mt-2 overflow-auto"><table className="w-full text-left text-xs whitespace-nowrap">
          <thead><tr>{["날짜 / 작업", "실패 원인", "요청", "확인된 출력", "할인 기준 추정"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{failures.map((row, i) => {
            const estimate = discountedFlashEstimate(row);
            return <tr key={i} className="border-t border-amber-100 align-top">
              <td className="p-2">{row.day.slice(5)} · {LLM_STAGE_LABELS[row.stage] ?? row.stage}<span className="block text-[10px] text-slate-500">{row.model} · Thinking {row.thinking === "enabled" ? "ON" : row.thinking === "disabled" ? "OFF" : "미확인"}</span></td>
              <td className="p-2">{usageFailureLabel(row)}</td><td className="p-2 text-right">{count(row.requests)}회</td>
              <td className="p-2 text-right">{count(row.outputTokens)}<span className="block text-[10px] text-slate-500">수신 {count(row.outputKnown)} / {count(row.requests)}회</span></td>
              <td className="p-2 text-right">{estimate ? `$${estimate.usd.toFixed(4)}` : "미계산"}{estimate && <span className="block text-[10px] text-slate-500">{count(estimate.requests)}회분</span>}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <p className="mt-2 text-xs text-slate-500">위 사용량 합계에 이미 포함된 내역입니다. 미계산은 비용 0을 뜻하지 않습니다.</p>
      </details>}
      {repeated.length > 0 && <details className="rounded border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm">최근 7일 반복 실패 글 (상위 20항목)</summary>
        <p className="mt-2 text-xs text-slate-500">기간 선택과 별개인 최근 7일 기록입니다. 같은 글의 여러 구간 실패도 합산하며, 현재 보류 상태는 아래에서 확인합니다.</p>
        <ul className="mt-2 space-y-2 text-xs text-slate-600">{repeated.map((row, i) => <li key={i} className="flex flex-wrap items-center gap-2">
          <span>글 #{row.articleId} · {LLM_STAGE_LABELS[row.stage] ?? row.stage} · {usageFailureLabel(row)} · {count(row.failures)}회 · 마지막 {new Date(row.lastAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</span>
          <button type="button" disabled={retry.isPending || api.mode === "static"}
            onClick={() => { retry.reset(); setRetryArticleId(row.articleId); }}
            className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50">1건 다시 분석</button>
        </li>)}</ul>
        {retryArticleId !== null && !retry.isPending && <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm space-y-2">
          <p>글 #{retryArticleId} 한 건의 재시도 제한을 해제하고 지금 다시 분석합니다. 완료된 구간 요약은 재사용하며 <strong>추가 API 비용이 발생합니다.</strong></p>
          <p className="text-xs text-slate-600">전체 API 오류 대기 중에도 선택한 한 건만 실행합니다. 다른 글의 재시도 제한과 전체 대기는 유지됩니다.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => retry.mutate(retryArticleId)} className="rounded bg-slate-900 px-3 py-1.5 text-white">확인 · 1건 다시 분석</button>
            <button type="button" onClick={() => setRetryArticleId(null)} className="rounded border border-slate-300 px-3 py-1.5">취소</button>
          </div>
        </div>}
        <div aria-live="polite" className="mt-2 text-sm">
          {retry.isPending && <p className="text-slate-600">글 #{retry.variables} 한 건을 분석 중입니다. 긴 글은 몇 분 걸릴 수 있습니다.</p>}
          {retry.isError && <p className="text-red-700">분석 응답을 확인하지 못했습니다. 서버에서 작업이 계속될 수 있으니 사용량과 아래 재시도 상태를 새로고침해 확인해주세요. 자동으로 다시 요청하지 않습니다.</p>}
          {retry.isSuccess && (retry.data.busy
            ? <p className="text-amber-700">다른 분석이 실행 중입니다. 추가 작업을 시작하지 않았습니다. 완료 후 다시 시도해주세요.</p>
            : retry.data.errors > 0
              ? <p className="text-red-700">글 #{retry.variables} 분석이 완료되지 않았습니다. 위 실패 원인과 아래 재시도 상태를 확인해주세요.</p>
              : retry.data.analyzed > 0
                ? <p className="text-emerald-700">글 #{retry.variables} 분석을 완료했습니다.</p>
                : <p className="text-slate-600">분석할 대기 글이 없어 추가 작업 없이 종료했습니다. 이미 분석되었거나 삭제된 글일 수 있습니다.</p>)}
        </div>
      </details>}
      <p className="text-xs leading-relaxed text-slate-500">추정 비용은 공식 DeepSeek Flash의 입력 캐시 적중·미적중·출력 사용량을 모두 받은 요청만 계산합니다. 100만 토큰당 $0.003 / $0.15 / $0.60을 적용한 참고값이며 실제 청구액은 아닙니다. 혼잡 시간에는 2배입니다. 제공자 요금 변경·사용량 미수신·다른 모델 비용은 반영하지 않습니다. 입력 캐시 할인과 완성된 요약 재사용은 다릅니다. 입력이 할인되어도 새 출력에는 비용이 발생합니다. <a className="underline" href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noreferrer">공식 요금표</a> (2026-09-21 확인)</p>
    </>}
  </section>;
}
