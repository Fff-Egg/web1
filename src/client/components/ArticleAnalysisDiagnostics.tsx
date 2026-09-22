import { useQuery } from "@tanstack/react-query";
import { api } from "../data/client.js";
import { LLM_STAGE_LABELS, usageFailureLabel } from "../../shared/llmUsageView.js";

const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const count = (n: number | null) => n === null ? "미수신" : n.toLocaleString("ko-KR");
const holdReasons: Record<string, string> = { output_limit: "작은 구간도 출력 한도 초과", recovery_budget: "추가 복구 횟수 소진",
  not_compressed: "요약이 입력보다 줄어들지 않음", too_many_levels: "요약 단계 한도 도달",
  packet_too_large: "최종 사실 메모가 전달 한도 초과" };

/** Only mounts after an explicit disclosure click; this query never calls the LLM. */
export function ArticleAnalysisDiagnostics({ articleId }: { articleId: number }) {
  const query = useQuery({ queryKey: ["articleAnalysisDiagnostics", articleId],
    queryFn: () => api.getArticleAnalysisDiagnostics(articleId), staleTime: 30_000 });
  const a = query.data?.article;
  const r = a?.reading;
  return <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>글 #{articleId} 처리 내역</strong>
      <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50">처리 내역 새로고침</button>
    </div>
    <p className="text-xs text-slate-500">저장된 본문·완료된 요약·API 호출 기록만 조회합니다. AI를 호출하거나 재시도 제한을 해제하지 않으며 추가 API 비용이 없습니다.</p>
    {query.isPending && <p>처리 내역을 불러오는 중…</p>}
    {query.error && <p className="text-red-700">처리 내역을 불러오지 못했습니다. 다시 조회해주세요.</p>}
    {query.data && !a && <p>{query.data.persisted ? "글이 없거나 휴지통으로 이동했습니다." : "DB가 연결되지 않아 처리 내역을 조회할 수 없습니다."}</p>}
    {a && <>
      <div className="space-y-1 break-words">
        <p className="font-medium">{a.title || "제목 없음"}</p>
        <p>출처: {a.provider ?? "미확인"}{a.url && <span className="block text-xs text-slate-500">{a.url}</span>}</p>
        <p>선별 분석: {a.analysis.completed ? `완료${a.analysis.analyzedAt ? ` · ${time(a.analysis.analyzedAt)}` : ""}` : "미완료"}</p>
        <p>저장 본문 {count(a.bodyChars)}자 · 최초 수집 본문 {a.sourceBodyChars === null ? "별도 저장 없음" : `${count(a.sourceBodyChars)}자`}</p>
        <p>수집 범위: {a.content.scope}{a.content.pending ? " · 수집 처리 대기" : ""}</p>
        <p className="text-xs text-slate-500">연결 원문 추출 {a.content.extractedLinks}건 / 미수집 {a.content.unavailableLinks}건{a.content.checkedAt ? ` · 확인 ${time(a.content.checkedAt)}` : ""}</p>
      </div>
      {r ? <div className="space-y-1">
        <p>전체 읽기: {r.completedAt ? `완료 · ${time(r.completedAt)}` : "미완료"} · 입력 {count(r.inputChars)}자 / 기본 구간 {count(r.chunkCount)}개</p>
        {a.sourceReading && <p>원문 구간별 읽기: {a.sourceReading.completed
          ? `전 구간 저장됨 · 순서대로 합친 사실 메모 ${count(a.sourceReading.chars)}자 / ${count(a.sourceReading.bytes)}바이트`
          : "아직 저장되지 않은 원문 구간이 있습니다."}</p>}
        <p>완료된 캐시 {count(r.savedChunkCount)}개 · 저장 요약 합계 {count(r.savedChunkChars)}자</p>
        <p className="text-xs text-slate-500">캐시는 부모·자식 구간 요약을 함께 포함합니다. 개수나 합계 글자 수가 고유 원문의 처리량을 뜻하지는 않습니다.</p>
        {r.recovery && <>
          <p>읽기 정책 {r.recovery.policy ?? "이전 버전"} · 추가 복구 호출 {count(r.recovery.calls)}회 · 분할 계획 {count(r.recovery.splitCount)}개 (사전 분할 {count(r.recovery.proactiveSplitCount)}개)</p>
          <p>저장된 요청당 입력 상한: {r.recovery.inputCharLimit === null ? "별도 기록 없음" : `${count(r.recovery.inputCharLimit)}자`}</p>
          {r.recovery.held && <p className="text-amber-800">읽기 보류: {holdReasons[r.recovery.held.reason] ?? r.recovery.held.reason} · {time(r.recovery.held.at)}</p>}
        </>}
        {r.samples.length > 0 && <details className="rounded border border-slate-200 bg-white p-2">
          <summary className="cursor-pointer">완료된 요약 표본 {r.samples.length}개 보기</summary>
          <p className="mt-2 text-xs text-slate-500">캐시 키 정렬의 처음·중간·끝 표본입니다. 원문 순서를 뜻하지 않습니다. 긴 표본은 화면에서만 3,000자까지 표시합니다.</p>
          {r.samples.map(sample => <div key={sample.ordinal} className="mt-3">
            <p className="text-xs text-slate-500">표본 #{sample.ordinal} · 원래 {count(sample.chars)}자{sample.truncated ? " · 화면 표시 생략 있음" : ""}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-2 text-xs">{sample.text}</pre>
          </div>)}
        </details>}
      </div> : <p>저장된 전체 읽기 캐시가 없습니다.</p>}
      <details className="rounded border border-slate-200 bg-white p-2">
        <summary className="cursor-pointer">저장된 전체 본문 보기 · {count(a.bodyChars)}자</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{a.body || "본문 없음"}</pre>
      </details>
      <div>
        <p className="font-medium">최근 API 호출 {a.attempts.length}건 · 최신순, 최대 30건</p>
        <p className="text-xs text-slate-500">최근 호출 기록의 성공은 해당 API 응답이 정상이라는 뜻이며 글 전체 분석 완료와는 다릅니다. 같은 글의 여러 구간 호출도 포함합니다.</p>
        {a.attempts.length ? <div className="mt-2 max-h-72 overflow-auto"><table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="sticky top-0 bg-slate-100"><tr>{["한국시간", "작업 / 모델", "결과", "출력 토큰", "입력 토큰"].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{a.attempts.map((attempt, i) => <tr key={i} className="border-t border-slate-200 align-top">
            <td className="p-2">{time(attempt.startedAt)}<span className="block text-slate-500">{(attempt.durationMs / 1000).toFixed(1)}초</span></td>
            <td className="p-2">{LLM_STAGE_LABELS[attempt.stage] ?? attempt.stage}<span className="block text-slate-500">{attempt.model} · Thinking {attempt.thinking === "enabled" ? "ON" : attempt.thinking === "disabled" ? "OFF" : "미확인"}</span></td>
            <td className={`p-2 ${attempt.success ? "text-emerald-700" : "text-red-700"}`}>{attempt.success ? "정상 응답" : usageFailureLabel(attempt)}<span className="block text-slate-500">HTTP {attempt.httpStatus ?? "미수신"} · 종료 {attempt.finishReason ?? "미수신"}</span></td>
            <td className="p-2 text-right">{count(attempt.outputTokens)}</td><td className="p-2 text-right">{count(attempt.inputTokens)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="mt-2 text-xs text-slate-500">이 글에 저장된 API 호출 기록이 없습니다.</p>}
      </div>
    </>}
  </div>;
}
