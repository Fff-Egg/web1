import type { AnalysisConfig } from "../server/db/schema.js";

export type { AnalysisConfig };

/**
 * Default analysis instructions. This is just the starting value — the user
 * edits it freely from the Settings tab. It plays the role of the system
 * prompt that drives how each article is analyzed.
 */
export const DEFAULT_INSTRUCTIONS = `너는 내 개인 투자 리서치 어시스턴트다. 아래 내 관점을 기준으로 주어진 글을 분석한다.

[내 관점]
- 관심 테마/섹터: (예: AI 반도체, 2차전지, 국내 바이오 — 직접 수정하세요)
- 보유/관심 종목과 논제: (예: 엔비디아 — AI 데이터센터 수요가 구조적으로 증가한다)
- 투자 스타일: (예: 6개월~2년 중장기, 중간 정도 리스크 성향)

위 관점에서, 주어진 글이 내 논제를 강화하는지/약화하는지에 초점을 맞춰 분석한다.
내 관심 밖이면 impact=neutral 로 두고 그 이유를 implications 에 적는다.`;

export const DEFAULT_RELEVANCE_CRITERIA = `위 관심 테마/섹터/종목과 직접 관련이 있으면 관련 있음. 단순 일반 뉴스/광고/잡담은 관련 없음.`;

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  instructions: DEFAULT_INSTRUCTIONS,
  relevanceCriteria: DEFAULT_RELEVANCE_CRITERIA,
};

/** The fixed JSON output contract appended to the user's instructions for deep analysis. */
export const ANALYSIS_OUTPUT_CONTRACT = `주어진 글에 대해 아래 JSON으로만 응답한다 (마크다운/코드펜스/설명 금지):
{
  "summary": "핵심을 한국어 3문장 이내로",
  "implications": "내 관점에서 왜 중요한지. 내 논제를 강화/약화하는지 명시",
  "tickers": ["관련 종목 티커, 없으면 빈 배열"],
  "themes": ["관련 테마"],
  "impact": "bullish | bearish | neutral"
}`;

// ─── Manual (Max subscription) analysis helpers ─────────────────────
// Used by the manual flow: build a block to paste into claude.ai, and parse
// the JSON answer back. No API key required.

export type ImpactValue = "bullish" | "bearish" | "neutral";

export interface ParsedAnalysis {
  summary: string;
  implications: string;
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
    tickers: Array.isArray(obj.tickers) ? obj.tickers.map(String) : [],
    themes: Array.isArray(obj.themes) ? obj.themes.map(String) : [],
    impact,
  };
}
