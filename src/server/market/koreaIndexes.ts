import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { fetchCloses } from "./tradingview.js";

/**
 * KOSPI / KOSDAQ index daily closes for the K-공포지수 대시보드.
 *
 * Both markets are computed independently (per-market credit + index), and the
 * FEAR index's F4 component is the index's own 20-day realized volatility — a
 * VKOSPI stand-in, so we no longer need the (anonymous-TV-unavailable) VKOSPI
 * symbol. Fetched via the TradingView chart WS (the pipe proven on Railway for
 * S5FI/NDFI/FRED); symbols are tried in order, first with data wins.
 *
 * Depth: the FEAR/signal math needs a 252-day rolling percentile that itself
 * sits on a 60-day MA (이격도), so ~311 trading days must precede the first valid
 * point. DAYS=1200 calendar (~820 trading) leaves ~500 days of computable FEAR
 * for the trend chart.
 */

const KOSPI_SYMBOLS = ["KRX:KOSPI", "TVC:KOSPI"];
const KOSDAQ_SYMBOLS = ["KRX:KOSDAQ", "TVC:KOSDAQ"];
const DAYS = 1200;

async function firstWithData(symbols: string[], timeoutMs: number): Promise<SeriesPoint[]> {
  for (const sym of symbols) {
    const pts = await fetchCloses(sym, timeoutMs).catch(() => [] as SeriesPoint[]);
    if (pts.length > 0) return sliceLastYear(pts, DAYS);
  }
  return [];
}

export async function fetchKoreaIndexes(
  timeoutMs = 22_000,
): Promise<{ kospiClose: SeriesPoint[]; kosdaqClose: SeriesPoint[] }> {
  const [kospiClose, kosdaqClose] = await Promise.all([
    firstWithData(KOSPI_SYMBOLS, timeoutMs),
    firstWithData(KOSDAQ_SYMBOLS, timeoutMs),
  ]);
  return { kospiClose, kosdaqClose };
}
