import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { fetchCloses } from "./tradingview.js";

/**
 * Inputs for the 캐피출레이션 바닥 감지 패널 that aren't already collected:
 *  - KOSPI index close  (이격도 60일 + 신용잔고 신호의 '지수 하락 동행' 판정)
 *  - VKOSPI (KOSPI 변동성지수) close
 * Both via TradingView's chart WS (the pipe already proven on Railway for
 * S5FI/NDFI/FRED). Symbols are tried in order; first with data wins. Sliced to
 * ~1.5y — the signals use 252-day rolling windows.
 */

const KOSPI_SYMBOLS = ["KRX:KOSPI", "TVC:KOSPI"];
const VKOSPI_SYMBOLS = ["KRX:KSVKOSPI", "KRX:VKOSPI", "KRX:VKOSPI200", "ECONOMICS:KRVIX"];
// 이격도(60) needs 60-day SMA warmup (drops the first 59 closes) BEFORE its own
// 252-day percentile window can fill, i.e. ~311 trading days ≈ 450+ calendar
// days. 750 calendar days (~510 trading days) leaves comfortable margin.
const DAYS = 750;

async function firstWithData(symbols: string[], timeoutMs: number): Promise<SeriesPoint[]> {
  for (const sym of symbols) {
    const pts = await fetchCloses(sym, timeoutMs).catch(() => [] as SeriesPoint[]);
    if (pts.length > 0) return sliceLastYear(pts, DAYS);
  }
  return [];
}

export async function fetchKoreaIndexes(
  timeoutMs = 22_000,
): Promise<{ kospiClose: SeriesPoint[]; vkospi: SeriesPoint[] }> {
  const [kospiClose, vkospi] = await Promise.all([
    firstWithData(KOSPI_SYMBOLS, timeoutMs),
    firstWithData(VKOSPI_SYMBOLS, timeoutMs),
  ]);
  return { kospiClose, vkospi };
}
