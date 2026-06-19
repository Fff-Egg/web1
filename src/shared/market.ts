/**
 * 시황분석 (Market Analysis) — shared types for the market snapshot.
 *
 * The snapshot is collected once a day (a single batch, see scheduler) from
 * three free sources and stored as JSON under settings key="marketSnapshot".
 * Both the server (collector) and the client (MarketPage) import these types.
 *
 *  - Fear & Greed (CNN)         → market sentiment, US, settles after US close.
 *  - S5FI / NDFI (TradingView)  → breadth (% of index above its 50-day MA),
 *                                 US, end-of-day values.
 *  - ADR KOSPI/KOSDAQ (adrinfo) → Korean advance-decline ratio, settles at the
 *                                 KR close (15:30 KST).
 *
 * Because the US data is overnight (relative to KST) and the KR data is from the
 * prior KR session, a single morning batch (default 07:00 KST) captures every
 * source at its freshest *settled* value.
 */

/** CNN Fear & Greed Index (0–100). */
export interface FearGreed {
  /** Current score 0–100. */
  score: number;
  /** "extreme fear" | "fear" | "neutral" | "greed" | "extreme greed". */
  rating: string;
  /** Previous trading day's close. */
  prevClose: number | null;
  /** Value one week ago. */
  week: number | null;
  /** Value one month ago. */
  month: number | null;
  /** Value one year ago. */
  year: number | null;
  /** Source timestamp (ISO), when available. */
  asOf: string | null;
}

/** A TradingView breadth quote (% of an index's members above their 50-day MA). */
export interface BreadthQuote {
  /** Last value (0–100). */
  value: number;
  /** Absolute change vs previous close. */
  change: number | null;
  /** Percent change vs previous close. */
  changePct: number | null;
}

/** Korean advance-decline ratio for one market. */
export interface AdrQuote {
  /** Current ADR (%). */
  value: number;
  /** Previous trading day's close. */
  prevClose: number | null;
}

export interface MarketSnapshot {
  /** When this snapshot was collected (ISO). */
  fetchedAt: string;
  fearGreed: FearGreed | null;
  breadth: {
    /** S&P 500 stocks above 50-day average. */
    s5fi: BreadthQuote | null;
    /** Nasdaq 100 stocks above 50-day average. */
    ndfi: BreadthQuote | null;
  };
  adr: {
    kospi: AdrQuote | null;
    kosdaq: AdrQuote | null;
  };
  /** Human-readable notes about any source that failed (Korean). */
  errors: string[];
}

/** Map a Fear & Greed score (0–100) to a Korean label. */
export function fearGreedLabelKo(score: number): string {
  if (score <= 24) return "극단적 공포";
  if (score <= 44) return "공포";
  if (score <= 55) return "중립";
  if (score <= 74) return "탐욕";
  return "극단적 탐욕";
}
