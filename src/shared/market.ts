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

/** One point on a daily history line: timestamp (ms) + value. */
export interface SeriesPoint {
  /** Epoch milliseconds (UTC) of the trading day. */
  t: number;
  /** The metric's value that day. */
  v: number;
}

/** ~1 year of daily history per metric, for the charts. */
export interface MarketHistory {
  fearGreed: SeriesPoint[];
  s5fi: SeriesPoint[];
  ndfi: SeriesPoint[];
  kospiAdr: SeriesPoint[];
  kosdaqAdr: SeriesPoint[];
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
  /** ~1 year of daily history for each metric (empty arrays if unavailable). */
  history: MarketHistory;
  /** Human-readable notes about any source that failed (Korean). */
  errors: string[];
}

/** Keep only points within the last `days` (default ~1 year), ascending by time. */
export function sliceLastYear(points: SeriesPoint[], days = 370): SeriesPoint[] {
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  return points.filter((p) => p.t >= cutoff).sort((a, b) => a.t - b.t);
}

/** Map a Fear & Greed score (0–100) to a Korean label. */
export function fearGreedLabelKo(score: number): string {
  if (score <= 24) return "극단적 공포";
  if (score <= 44) return "공포";
  if (score <= 55) return "중립";
  if (score <= 74) return "탐욕";
  return "극단적 탐욕";
}
