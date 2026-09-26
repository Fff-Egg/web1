/** A normalized report row produced by a source collector (네이버 / 한경). */
export interface ParsedReport {
  /** Where this row came from: "naver" | "hankyung". */
  source: string;
  reportDate: string;
  category: string;
  title: string;
  stockName: string | null;
  stockCode: string | null;
  targetPrice: string | null;
  targetPriceNum: number | null;
  opinion: string | null;
  broker: string | null;
  pdfUrl: string | null;
  externalId: string;
  /** Read-page URL — used to enrich Naver company reports with TP/opinion/요약 (not stored). */
  detailUrl?: string;
  /** Filled by the collector after enrichment. */
  summary?: string | null;
  marketCap?: number | null;
}

/** Only these categories are collected/shown (기업·산업 리포트만). */
export const ALLOWED_CATEGORIES = new Set(["기업", "산업"]);
