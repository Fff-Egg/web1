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

/**
 * Korean margin-loan (신용거래융자) balance for one market, in 조원 (trillion KRW).
 * Source: KOFIA FreeSIS 신용공여 잔고 추이 (service STATSCU0100000070), split into
 * 유가증권(KOSPI) / 코스닥, settled at the KR close.
 */
export interface CreditQuote {
  /** Latest balance, in 조원 (trillion won). */
  value: number;
  /** Previous trading day's balance (조원), for the delta. */
  prevValue: number | null;
}

/**
 * US net-liquidity gauge — the macro liquidity backdrop the other indicators lack.
 * All levels in $T (trillion USD). Net = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN).
 * These FRED series are WEEKLY (Wed level, published Thu) and LAGGING — a slow
 * context axis, NOT a buy/sell timing signal. See MarketPage's caution note.
 */
export interface LiquidityQuote {
  /** Net liquidity level, $T. Null when TGA/WALCL didn't load (the drivers below
   *  may still be present — a partial card beats an all-or-nothing "데이터 없음"). */
  net: number | null;
  /** 4-week change in net liquidity, $T (the impulse — matters more than the level). */
  net4wChange: number | null;
  /** Reserve balances (WRESBAL), $T — bank-level liquidity, overlaid on the chart. */
  reserves: number | null;
  /** RRP (RRPONTSYD), $T — near-zero in 2026; shown as context only. */
  rrp: number | null;
  /** TGA (WTREGEN), $T. */
  tga: number | null;
  /** As-of date of the latest weekly point (ISO). */
  asOf: string | null;
}

/** One point on a daily history line: timestamp (ms) + value. */
export interface SeriesPoint {
  /** Epoch milliseconds (UTC) of the trading day. */
  t: number;
  /** The metric's value that day. */
  v: number;
}

/** One OHLC candle (for the custom slot's candlestick chart). */
export interface OHLC {
  /** Epoch milliseconds (UTC) of the bar's open. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Candlestick timeframes offered for the custom slot. */
export const TIMEFRAMES = ["4h", "1D", "1W", "1M", "1Y"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Korean label for a timeframe. */
export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "4h": "4시간",
  "1D": "일",
  "1W": "주",
  "1M": "월",
  "1Y": "년",
};

/** A user-chosen TradingView symbol occupying the configurable chart slot. */
export interface CustomMetric {
  /** TradingView symbol, e.g. "CBOE:VIX", "NYMEX:CL1!", "NASDAQ:AAPL". */
  symbol: string;
  /** Resolved display name (description/short name), if available. */
  name: string | null;
  quote: BreadthQuote | null;
}

/** ~1 year of daily history per metric, for the charts. */
export interface MarketHistory {
  fearGreed: SeriesPoint[];
  /** History for the user-configurable symbol slot. */
  custom: SeriesPoint[];
  s5fi: SeriesPoint[];
  ndfi: SeriesPoint[];
  kospiAdr: SeriesPoint[];
  kosdaqAdr: SeriesPoint[];
  /** 신용거래융자 잔고 history (조원), KOSPI / KOSDAQ. */
  creditKospi: SeriesPoint[];
  creditKosdaq: SeriesPoint[];
  /** US 순유동성 ($T, weekly) and its drivers, each its own line so the trend of
   *  each is visible (TGA ↑ = 유동성 흡수, ↓ = 방출; RRP near-zero in 2026). */
  netLiquidity: SeriesPoint[];
  reserves: SeriesPoint[];
  tga: SeriesPoint[];
  rrp: SeriesPoint[];
  /** Inputs for the K-공포지수 대시보드 (all daily):
   *  KOSPI/KOSDAQ index close (이격도·지수방향·실현변동성 F4), 미수 반대매매 비중(%).
   *  vkospi는 레거시(F4 실현변동성이 대체) — 하위호환 위해 필드만 유지, 미수집. */
  kospiClose: SeriesPoint[];
  kosdaqClose: SeriesPoint[];
  vkospi: SeriesPoint[];
  /** 미수금 대비 반대매매 **비중(%)** — 표시·폴백용(분모 미수금 왜곡 있음). */
  forcedLiqRatio: SeriesPoint[];
  /** 위탁매매 미수금 대비 실제 반대매매 **금액(절대치)** — v4 F2·S2의 주 입력.
   *  비중과 달리 분모 왜곡이 없어 강제청산 강도를 곧게 잰다. pct252는 스케일 무관이라
   *  단위(백만원/÷8)는 상관없음. */
  forcedLiqAmount: SeriesPoint[];
  /** US 진입신호 실행기 입력 (all daily, US 종가):
   *  VIX·VIX3M(→ TERM=VIX/VIX3M), HY OAS(ICE BofA, FRED BAMLH0A0HYM2, T+1 — 판정은 shift(1)),
   *  IXIC(나스닥종합 — 신호엔 불필요, 첫 발동가 대비 등락률·성과추적용). */
  vix: SeriesPoint[];
  vix3m: SeriesPoint[];
  hyOas: SeriesPoint[];
  ixic: SeriesPoint[];
}

export interface MarketSnapshot {
  /** When this snapshot was collected (ISO). */
  fetchedAt: string;
  fearGreed: FearGreed | null;
  /** User-configurable TradingView symbol slot (defaults to CBOE:VIX). */
  custom: CustomMetric | null;
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
  /** 신용거래융자 잔고 (margin-loan balance), 조원, KOSPI / KOSDAQ. */
  credit: {
    kospi: CreditQuote | null;
    kosdaq: CreditQuote | null;
  };
  /** US 순유동성 (Fed BS − RRP − TGA), weekly · lagging · 매크로 배경 지표. */
  liquidity: LiquidityQuote | null;
  /** ~1 year of daily history for each metric (empty arrays if unavailable). */
  history: MarketHistory;
  /** Human-readable notes about any source that failed (Korean). */
  errors: string[];
}

/** Default stored-history window (~5 years) so the 월/년 timeframe toggles have
 *  depth. Sources with less raw data just return whatever they have. */
export const HISTORY_DAYS = 1825;

/** Keep only points within the last `days` (default ~5 years), ascending by time. */
export function sliceLastYear(points: SeriesPoint[], days = HISTORY_DAYS): SeriesPoint[] {
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
