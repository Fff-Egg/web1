import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { fetchCloses } from "./tradingview.js";
import { assertAnchor } from "./anchors.js";

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
  // HARD 앵커: 심볼이 바뀌거나 엉뚱한 종목이 잡히면 throw → 지수 통째 거부(F3·F4가
  // 틀린 종가로 계산되는 걸 차단). tz 오프셋 대비 ±1일 창에서 "근처 봉 중 하나라도
  // 기준값이면 통과". 코스피 2026-06-23=8203.84, 2026-07-08=7246.79 (KRX 실측).
  assertAnchor(kospiClose, 2026, 6, 23, 8203.84, 45, 1, "코스피 종가");
  assertAnchor(kospiClose, 2026, 7, 8, 7246.79, 45, 1, "코스피 종가");
  return { kospiClose, kosdaqClose };
}
