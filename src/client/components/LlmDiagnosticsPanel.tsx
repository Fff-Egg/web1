import { useState } from "react";
import type { LlmCallDiagnostics } from "../../shared/llmDiagnostics.js";

const stages: Record<LlmCallDiagnostics["stage"], string> = {
  preparing: "요청 준비", awaiting_headers: "응답 헤더 대기",
  reading_body: "응답 본문 수신 중", parsing_response: "응답 JSON 해석",
  validating_response: "완성 본문 검증", complete: "완료",
};
const seconds = (ms?: number) => ms === undefined ? "확인 불가" : `${(ms / 1000).toFixed(2)}초`;
const count = (n?: number) => n === undefined ? "확인 불가" : n.toLocaleString();

export function LlmDiagnosticsPanel({ diagnostics: d, runId, elapsedMs }: {
  diagnostics?: LlmCallDiagnostics; runId?: string; elapsedMs?: number;
}) {
  const [copyState, setCopyState] = useState("");
  if (!d) return <p className="mt-1 opacity-70">상세 계측 기록 없음 — 적용 후 새 실행부터 표시됩니다.{elapsedMs !== undefined ? ` 소요 ${seconds(elapsedMs)}.` : ""}</p>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ runId, diagnostics: d }, null, 2));
      setCopyState("복사했습니다");
    } catch { setCopyState("복사 실패 — 아래 상세 JSON을 펼쳐 직접 복사해 주세요"); }
  };
  return <div className="mt-1.5 rounded border border-amber-200 bg-white/70 p-2 text-[11px]">
    <p><strong>소요 {seconds(d.durationMs)} · {stages[d.stage] ?? d.stage}</strong> · HTTP {d.httpStatus ?? "미수신"}</p>
    <p>입력: 시스템 {count(d.systemChars)}자 + 자료 {count(d.userChars)}자 · 요청 {count(d.requestBytes)}바이트</p>
    <p>응답 수신 {count(d.receivedBytes)}바이트 / {count(d.receivedChunks)}청크 · 마지막 수신 후 대기 {seconds(d.idleMs)}</p>
    <p>요청 시작 기준: 헤더 {seconds(d.headersMs)} · 첫 데이터 {seconds(d.firstByteMs)} · 마지막 데이터 {seconds(d.lastByteMs)}</p>
    <p>스트리밍 {d.stream ? "ON" : "OFF"} · 앱 자체 타임아웃 미설정 (통신 계층·제공자 제한은 별도)</p>
    {d.stream && <p>첫 사고 응답 {seconds(d.firstReasoningMs)} · 첫 본문 {seconds(d.firstContentMs)} · 스트림 종료 신호 {d.streamCompleted === undefined ? "확인 불가" : d.streamCompleted ? "수신" : "미수신"}</p>}
    <p>실제 요청 상한 {count(d.effectiveMaxTokens)}토큰 · 제공자 보고: 입력 {count(d.promptTokens)} / 출력 {count(d.completionTokens)}토큰</p>
    <p>종료 사유 {d.finishReason ?? "미수신"} · 사고 {count(d.reasoningChars)}자 / 본문 {count(d.contentChars)}자</p>
    <p className="break-all">오류 코드 {d.errorCodes?.join(" → ") || "미확인"} · 서버 {d.endpointHost ?? "미확인"} · Node {d.nodeVersion}</p>
    <p className="mt-1 opacity-70">수신 바이트에는 연결 유지 신호도 포함되며, 사고 글자 수는 토큰 수가 아닙니다. 연결 종료만으로 제공자·중간 네트워크 중 어디가 원인인지 단정할 수 없습니다.</p>
    <button type="button" onClick={copy} className="mt-1.5 rounded border border-amber-300 px-2 py-1 font-medium">진단 정보 복사</button>
    <span role="status" className="ml-2">{copyState}</span>
    <details className="mt-1"><summary className="cursor-pointer">상세 JSON (요청 식별자 포함)</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all text-[10px]">{JSON.stringify({ runId, diagnostics: d }, null, 2)}</pre>
    </details>
  </div>;
}
