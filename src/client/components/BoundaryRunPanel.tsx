import type { BoundaryRun } from "../../shared/boundaryRun.js";

const stateLabels: Record<BoundaryRun["state"], string> = {
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  interrupted: "중단됨",
};
const cleanupLabels: Record<string, string> = {
  morning_digest_missing: "아침분 보고서가 없습니다",
  trace_missing: "기존 보고서의 완료 기록을 확인할 수 없습니다",
  final_fallback: "설정한 최종 모델 대신 대체 설정으로 작성됐습니다",
  final_incomplete: "최종 보고서가 완성되지 않았습니다",
  map_incomplete: "일부 자료 정리가 완료되지 않았습니다",
};
const resultLabels = { created: "생성 완료", existing: "기존 보고서 확인", empty: "종합할 글 없음" };

export function BoundaryRunPanel({ run, onOpenDigest }: { run: BoundaryRun; onOpenDigest: (id: number) => void }) {
  const color = run.state === "running"
    ? "border-blue-200 bg-blue-50 text-blue-800"
    : run.state === "succeeded"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div className={`mt-2 rounded border p-3 text-xs ${color}`}>
      <div role="status" aria-live="polite">
        <p className="font-semibold">{run.date} 작업 · {stateLabels[run.state]}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{run.message}</p>
      </div>
      <p className="mt-1 opacity-70">실행 번호: {run.id.slice(0, 8)}</p>
      {run.state === "running" && <p className="mt-1 opacity-80">서버의 진행 상태를 자동으로 확인하고 있습니다.</p>}
      {run.result && (
        <>
          <p className="mt-1">낮분: {resultLabels[run.result.midday]} · 아침분: {resultLabels[run.result.morning]}</p>
          <p className="mt-1">{run.result.sweepSkippedReason
            ? `피드 정리 보류: ${cleanupLabels[run.result.sweepSkippedReason] ?? "보고서 완료 여부를 확인해야 합니다"}`
            : `피드 ${run.result.swept}건을 정리했습니다.`}</p>
        </>
      )}
      {run.warnings.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-1">
          {run.warnings.map((warning, i) => <li key={i} className="break-words">{warning}</li>)}
        </ul>
      )}
      {run.digestIds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span>확인된 보고서:</span>
          {run.digestIds.map((id, index) => (
            <button key={id} type="button" onClick={() => onOpenDigest(id)} className="rounded border border-current px-2 py-1 hover:bg-white/60">
              보고서 {index + 1} 보기
            </button>
          ))}
        </div>
      )}
      {(run.state === "failed" || run.state === "interrupted") && (
        <p className="mt-2">원인을 해결한 뒤 위 작업 실행 버튼으로 다시 시도할 수 있습니다.</p>
      )}
    </div>
  );
}
