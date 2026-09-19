import type { ManualDigestRun } from "../../shared/manualDigestRun.js";

const stateLabels: Record<ManualDigestRun["state"], string> = {
  running: "생성 중",
  succeeded: "생성 완료",
  empty: "종합할 자료 없음",
  failed: "생성 실패",
  interrupted: "중단됨",
};

export function ManualDigestRunPanel({ run, windowLabel, onOpenDigest }: {
  run: ManualDigestRun;
  windowLabel: string;
  onOpenDigest: (id: number) => void;
}) {
  const color = run.state === "running"
    ? "border-blue-200 bg-blue-50 text-blue-800"
    : run.state === "succeeded"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-amber-200 bg-amber-50 text-amber-900";
  const sources = run.sources;
  const exclusions = sources?.excluded;
  const hasBacklog = !run.request.fromDigests && (sources?.pendingAnalysis ?? 0) > 0;
  const stamp = (value: string) => new Date(value).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return (
    <div className={`mt-3 rounded border p-3 text-xs ${color}`}>
      <div role="status" aria-live="polite">
        <p className="font-semibold">수동 생성 · {stateLabels[run.state]}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{run.message}</p>
      </div>
      <p className="mt-1">요청 기간: {windowLabel} (한국 시간)</p>
      {run.request.title && <p className="mt-1 break-words">이름: {run.request.title}</p>}
      {sources && (
        <div className="mt-2 space-y-1 border-t border-current/20 pt-2">
          <p className="font-medium">실행 당시 자료 현황</p>
          <p>
            {sources.feedEligible === null ? "저장된 다이제스트에서만 종합" : `이 기간의 종합 대상 피드: ${sources.feedEligible}건`}
            {sources.savedDigests !== null && ` · 저장 다이제스트: ${sources.savedDigests}건`}
          </p>
          {sources.source === "digests" && <p>저장된 다이제스트를 종합 자료로 사용합니다.</p>}
          {exclusions && (
            <p>이 기간의 제외된 글: 검토 {exclusions.review}건 · 원문확인 {exclusions.sourceReview}건 · 휴지통 {exclusions.trashed}건</p>
          )}
          {hasBacklog && (
            <>
              <p>실행 당시 전체 수집 글 중 1차 선별 대기 {sources.pendingAnalysis}건. 다이제스트는 선별이 완료된 글만 사용합니다.</p>
              {sources.automaticAnalysisDeferred && sources.analysisResumeHour !== undefined && (
                <p>실행 당시 앱의 절약 설정으로 자동 선별이 대기 중이었습니다. 재개 기준은 {String(sources.analysisResumeHour).padStart(2, "0")}시 이후입니다.</p>
              )}
              <p>늦게 선별된 글은 선별된 시각의 기간에 들어갑니다. 선별 완료 후 “오늘 모인 글”에서 확인하세요.</p>
            </>
          )}
          {!sources.llmConfigured && <p>실행 당시 서버에 AI API가 설정되어 있지 않았습니다.</p>}
        </div>
      )}
      {run.state === "running" && <p className="mt-2">서버의 진행 상태를 자동으로 확인합니다. 완료되면 이 작업의 보고서를 엽니다.</p>}
      {run.state === "empty" && (
        <div className="mt-2 space-y-1">
          {run.request.fromDigests
            ? <p>해당 기간에 저장된 다이제스트가 있는지 확인하고 기간을 다시 선택하세요.</p>
            : <>
                {(exclusions?.review ?? 0) > 0 && <p>Feed의 “검토”에서 포함할 글을 확인하고 “남기기”로 중요 글로 바꾼 뒤 다시 생성하세요.</p>}
                {(exclusions?.sourceReview ?? 0) > 0 && <p>Feed의 “원문확인”에서 본문 수집 상태를 확인하세요.</p>}
                {(exclusions?.trashed ?? 0) > 0 && <p>Feed → 휴지통에서 필요한 글과 삭제 전 분류를 확인하세요.</p>}
                {!hasBacklog && <p>선택한 기간과 Feed의 추가일을 확인한 뒤 다시 생성할 수 있습니다.</p>}
              </>}
        </div>
      )}
      {(run.state === "failed" || run.state === "interrupted") && (
        <p className="mt-2">원인을 해결한 뒤 위 “생성” 버튼으로 다시 시도할 수 있습니다.</p>
      )}
      {run.digestId !== undefined && (
        <button type="button" onClick={() => onOpenDigest(run.digestId!)} className="mt-2 rounded border border-current px-2 py-1 hover:bg-white/60">
          생성된 보고서 보기
        </button>
      )}
      <p className="mt-2 opacity-70">시작: {stamp(run.startedAt)} · 상태 갱신: {stamp(run.updatedAt)} (한국 시간)</p>
      <p className="mt-1 opacity-70">선택 날짜: {run.request.start}{run.request.end !== run.request.start ? ` ~ ${run.request.end}` : ""} · 실행 번호: {run.id.slice(0, 8)}</p>
    </div>
  );
}
