import type { AnalysisConfig } from "../server/db/schema.js";

export type { AnalysisConfig };

/**
 * Default analysis instructions. This is just the starting value — the user
 * edits it freely from the Settings tab. It plays the role of the system
 * prompt that drives how each article is analyzed.
 */
export const DEFAULT_INSTRUCTIONS = `너는 섹터 비편향 개인 투자 리서치 보조자다. 현재 관심 논지는 결론을 제한하는 필터가 아니라 사후 비교용 가설일 뿐이다.

입력에서 먼저 확인 가능한 사실·주장·추측을 분리하고, 분야를 내용에서 동적으로 정한다. 반도체·전력뿐 아니라 바이오·방산·크립토·금융·소비·원자재·정책 등 어떤 분야도 같은 기준으로 본다.

분석은 관측 사실 → 직접 영향 → 2차·3차 파급 → 실제 병목/제약 → 수혜·비용 부담 주체 → 확인할 데이터 → 반증 조건 순서로 한다. 기존 관심 밖의 신호와 반대 증거를 적극적으로 보존한다. 매수·매도 권유와 목표가는 제시하지 않는다.`;

export const DEFAULT_RELEVANCE_CRITERIA = `투자·경제·산업·기술·기업·시장·정책·규제·사회적 수용성에 조금이라도 연결되는 관측은 관련 있음. 전력 부족, 인허가 지연, 주민 반대, 인력·원재료 부족처럼 다른 산업의 비용·공급·일정을 바꿀 수 있는 간접 신호도 포함한다. 바이오·방산·크립토를 포함해 섹터를 제한하지 않는다. 찌라시·업계 전언·소셜 신호는 미확인으로 표시해 보존한다. 순수 광고·인사·정보 없는 잡담·완전 동일 중복만 관련 없음. 애매하면 관련 있음.`;

/** 요약: Feed에 보일 한 글의 요약 방식. */
export const DEFAULT_SUMMARY_INSTRUCTIONS = `한국어 2~5문장으로 요약한다. 무엇이 관측됐는지와 숫자·날짜·주체를 보존하고 [확정/보도/업계전언/미확인/해석]을 표시한다. 직접 영향뿐 아니라 합리적인 2차 연결 가능성을 “가설”로 분리해 한 문장 적고, 확인할 데이터도 짧게 쓴다. 기존 논지에 억지로 연결하지 않는다.`;

/** 중요도: 검토 버킷은 "신뢰도가 낮음"이 아니라 정보 증가분이 없는 잡음 전용이다. */
export const DEFAULT_IMPORTANCE_CRITERIA = `신뢰도와 중요도를 분리한다. 기업·산업의 수요·공급·가격·일정·정책·수급을 바꾸거나 다른 분야로 파급될 수 있으면 높음. 기술 아키텍처·설계 선택·성능/비용 트레이드오프·병목·대체재/보완재·원가곡선·현장 실험·컨퍼런스 논쟁처럼 숫자나 검증 가능한 메커니즘이 있는 분석은 직접적인 실적·수급 뉴스가 아니어도 높음이다. 구체적인 찌라시·현장 전언·사회적 반대·개인의견도 맞을 경우 함의가 크면 높음. 정보 증가분이 없는 광고·인사·개인 일상·무정보 반응·완전 동일 중복만 낮음. 애매하면 높음.`;

/** `important=false`가 허용되는 유일한 이유. 모델의 자의적 저평가를 막는 fail-open 계약. */
export const LOW_PRIORITY_REASONS = ["광고", "인사", "개인일상", "무정보반응", "완전중복"] as const;

/**
 * A substantive article must not disappear into 검토 merely because it is an
 * opinion, unverified, indirect, or lacks an immediate earnings implication.
 * Only the exact no-information reasons above can produce low priority.
 */
export function shouldTreatAsImportant(
  parsed: Record<string, unknown> | null | undefined,
): boolean {
  if (!parsed || parsed.important !== false) return true;
  const reason = typeof parsed.lowReason === "string"
    ? parsed.lowReason.replace(/\s+/g, "").trim()
    : "";
  return !LOW_PRIORITY_REASONS.some((allowed) => allowed === reason);
}

/** 2차: 하루 1회, 그날 뽑힌 글들을 종합하는 다이제스트 지침. */
export const DEFAULT_DIGEST_INSTRUCTIONS = `너는 섹터 비편향 개인 투자 다이제스트 편집자다. 오늘 선별된 전체 글을 먼저 기존 관심 논지 없이 읽고, 분야를 입력에서 동적으로 묶는다.

구성:
## 오늘 새로 바뀐 것
- 섹터와 무관하게 시장·기업·공급망에 중요한 변화 3~5개.

## 반증·상충·미확인
- 확정 사실과 찌라시를 분리하고 가장 강한 반대 신호를 먼저 쓴다.

## 연결 가능한 인과 사슬
- 관측 사실 → 직접 영향 → 2차·3차 파급 → 병목/비용 부담 → 확인할 데이터 순서로 연결한다. 예: 전력 부족·건설 반대 → 인허가/계통연결 지연 → 데이터센터 공급 일정 변화. 연결은 사실이 아니라 가설이면 명시한다.

## 새롭게 떠오른 섹터·서사
- 바이오·방산·크립토 등 기존 관심 밖에서 반복되는 신호를 적극적으로 찾는다.

## 종목·테마별 메모
- 내용에서 동적으로 만든 종목·테마별 한 줄 메모.

규칙: 기존 논지는 사후 비교용으로만 사용하고 지면의 우선권을 주지 않는다. 입력에 없는 사실을 만들지 말고, 매수·매도 권유와 목표가를 제시하지 않는다.`;

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  instructions: DEFAULT_INSTRUCTIONS,
  relevanceCriteria: DEFAULT_RELEVANCE_CRITERIA,
  importanceCriteria: DEFAULT_IMPORTANCE_CRITERIA,
  summaryInstructions: DEFAULT_SUMMARY_INSTRUCTIONS,
  digestInstructions: DEFAULT_DIGEST_INSTRUCTIONS,
};

/** The fixed JSON output contract appended to the user's instructions for deep analysis. */
export const ANALYSIS_OUTPUT_CONTRACT = `주어진 글을 위 지침/프레임워크에 따라 분석하고, 아래 JSON 하나로만 응답한다 (코드펜스/추가 설명 금지):
{
  "fullAnalysis": "위 지침의 출력 형식을 모두 따른 완전한 분석 리포트. 한국어 마크다운, 판정-우선(verdict-first), 모든 섹션 포함. 줄바꿈은 \\n 으로.",
  "summary": "fullAnalysis의 핵심을 한국어 3문장 이내로 (피드 카드 요약용)",
  "implications": "내 논제를 강화/약화/반증하는지 한두 문장",
  "tickers": ["관련 종목 티커, 없으면 빈 배열"],
  "themes": ["관련 테마/스레드"],
  "impact": "bullish | bearish | neutral"
}`;

// ─── Manual (Max subscription) analysis helpers ─────────────────────
// Used by the manual flow: build a block to paste into claude.ai, and parse
// the JSON answer back. No API key required.

export type ImpactValue = "bullish" | "bearish" | "neutral";

export interface ParsedAnalysis {
  summary: string;
  implications: string;
  fullText: string;
  tickers: string[];
  themes: string[];
  impact: ImpactValue;
}

const MANUAL_BODY_CAP = 12000;

/** Build the text the user pastes into claude.ai for one article. */
export function buildManualPrompt(
  instructions: string,
  article: { title?: string | null; url?: string | null; source?: string | null; body?: string | null },
): string {
  const body = (article.body ?? "").slice(0, MANUAL_BODY_CAP);
  return (
    `${instructions}\n\n${ANALYSIS_OUTPUT_CONTRACT}\n\n` +
    `---\n` +
    `제목: ${article.title ?? ""}\n` +
    `출처: ${article.source ?? ""}\n` +
    `원문: ${article.url ?? ""}\n\n` +
    `본문:\n${body}`
  );
}

/** Strip code fences / surrounding prose and parse the JSON answer. */
export function parseAnalysisJson(text: string): ParsedAnalysis | null {
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  const impact: ImpactValue =
    obj.impact === "bullish" || obj.impact === "bearish" ? obj.impact : "neutral";
  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    implications: typeof obj.implications === "string" ? obj.implications : "",
    fullText: typeof obj.fullAnalysis === "string" ? obj.fullAnalysis : "",
    tickers: Array.isArray(obj.tickers) ? obj.tickers.map(String) : [],
    themes: Array.isArray(obj.themes) ? obj.themes.map(String) : [],
    impact,
  };
}
