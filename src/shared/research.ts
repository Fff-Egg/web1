/**
 * 리포트 (Broker Research) — shared types for the daily 증권사 리포트 board.
 *
 * Source: 한경 컨센서스 (consensus.hankyung.com). Each report is collected with its
 * 분류(category)·헤드라인·종목·적정가격(TP)·투자의견·증권사·PDF. The board groups by
 * category and tiers up stocks that are heavily covered (주요종목, ≥5 reports within the
 * last 5 working days) or whose target price was just raised (TP상향종목).
 */

/** Report categories (normalized). */
export const REPORT_CATEGORIES = ["기업", "산업", "시황", "투자", "경제", "채권", "파생", "기타"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** ≥ this many reports for a stock within the coverage window → 주요종목. */
export const MAJOR_THRESHOLD = 5;
/** Coverage window, in working days. */
export const COVERAGE_WORKDAYS = 5;

export interface ReportRow {
  id: number;
  /** 작성일, YYYY-MM-DD. */
  reportDate: string;
  category: string;
  /** 헤드라인(제목). */
  title: string;
  /** 주요 내용 — 리포트 본문 LLM 한 줄 요약 (없으면 null). */
  summary: string | null;
  /** 현재 시가총액(원), 없으면 null. */
  marketCap: number | null;
  stockName: string | null;
  stockCode: string | null;
  /** 적정가격(TP) 표시 문자열 (예: "90,000"). */
  targetPrice: string | null;
  opinion: string | null;
  broker: string | null;
  pdfUrl: string | null;
  /** 같은 종목이 최근 5영업일 내 다뤄진 리포트 수(이 날짜 포함). */
  coverageCount: number;
  /** coverageCount ≥ MAJOR_THRESHOLD → 주요종목. */
  isMajor: boolean;
  /** 같은 증권사가 이 종목의 직전 리포트 대비 목표주가를 올림 → TP상향종목. */
  tpRaised: boolean;
}

export interface ResearchList {
  /** 표시 중인 작성일 (YYYY-MM-DD), 데이터 없으면 null. */
  date: string | null;
  /** 선택 가능한 작성일 목록(최신순). */
  dates: string[];
  /** 정렬된 리포트(TP상향 → 주요 → 커버리지 → 종목명). */
  reports: ReportRow[];
  /** 마지막 수집 시각(ISO). */
  collectedAt: string | null;
  /** 수집 실패/주의 메모(한국어). */
  error?: string | null;
}
