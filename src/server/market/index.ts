import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { MarketSnapshot, MarketHistory, OHLC, Timeframe } from "../../shared/market.js";
import { fetchFearGreed } from "./cnn.js";
import { fetchBreadth, fetchSymbol, fetchCandles } from "./tradingview.js";
import { fetchAdr, fetchAdrHistory } from "./adr.js";
import { fetchCreditSnapshot } from "./credit.js";

const SNAPSHOT_KEY = "marketSnapshot";
const CUSTOM_SYMBOL_KEY = "marketCustomSymbol";
const DEFAULT_CUSTOM_SYMBOL = "CBOE:VIX";

const EMPTY_HISTORY: MarketHistory = {
  fearGreed: [],
  custom: [],
  s5fi: [],
  ndfi: [],
  kospiAdr: [],
  kosdaqAdr: [],
  creditKospi: [],
  creditKosdaq: [],
};

/** The TradingView symbol chosen for the configurable slot (default CBOE:VIX). */
export async function getCustomSymbol(): Promise<string> {
  if (!hasDb) return DEFAULT_CUSTOM_SYMBOL;
  const rows = await db.select().from(settings).where(eq(settings.key, CUSTOM_SYMBOL_KEY)).limit(1);
  const sym = (rows[0]?.value as { symbol?: string } | undefined)?.symbol;
  return sym && sym.trim() ? sym.trim() : DEFAULT_CUSTOM_SYMBOL;
}

async function setCustomSymbolValue(symbol: string): Promise<void> {
  if (!hasDb) return;
  const value = { symbol } as Record<string, unknown>;
  await db
    .insert(settings)
    .values({ key: CUSTOM_SYMBOL_KEY, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

/**
 * Collect a fresh snapshot from all sources in parallel. Each source is
 * independent and tolerant: a failure records a Korean note in `errors` and
 * leaves that section null/empty, so a single dead source never blocks the
 * others. Each source returns both the current value and ~1 year of daily
 * history (for the charts).
 */
export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const errors: string[] = [];
  const history: MarketHistory = { ...EMPTY_HISTORY };
  const customSymbol = await getCustomSymbol();

  const [fg, breadth, custom, adr, adrHist, credit] = await Promise.all([
    fetchFearGreed().catch((e: unknown) => {
      errors.push(`Fear & Greed 수집 실패: ${msg(e)}`);
      return null;
    }),
    fetchBreadth().catch((e: unknown) => {
      errors.push(`S5FI/NDFI 수집 실패: ${msg(e)}`);
      return null;
    }),
    fetchSymbol(customSymbol).catch((e: unknown) => {
      errors.push(`${customSymbol} 수집 실패: ${msg(e)}`);
      return null;
    }),
    fetchAdr().catch((e: unknown) => {
      errors.push(`ADR(코스피/코스닥) 현재값 수집 실패: ${msg(e)}`);
      return { kospi: null, kosdaq: null };
    }),
    fetchAdrHistory().catch((e: unknown) => {
      errors.push(`ADR 히스토리 수집 실패: ${msg(e)}`);
      return { kospi: [], kosdaq: [] };
    }),
    fetchCreditSnapshot().catch((e: unknown) => {
      errors.push(`신용잔고(KOFIA) 수집 실패: ${msg(e)}`);
      return { kospi: null, kosdaq: null, history: { kospi: [], kosdaq: [] } };
    }),
  ]);

  if (fg) history.fearGreed = fg.history;
  if (breadth) {
    history.s5fi = breadth.s5fi.history;
    history.ndfi = breadth.ndfi.history;
  }
  if (custom) history.custom = custom.history;
  history.kospiAdr = adrHist.kospi;
  history.kosdaqAdr = adrHist.kosdaq;
  history.creditKospi = credit.history.kospi;
  history.creditKosdaq = credit.history.kosdaq;

  return {
    fetchedAt: new Date().toISOString(),
    fearGreed: fg ? fg.current : null,
    custom: { symbol: customSymbol, name: custom?.name ?? null, quote: custom?.quote ?? null },
    breadth: {
      s5fi: breadth ? breadth.s5fi.quote : null,
      ndfi: breadth ? breadth.ndfi.quote : null,
    },
    adr,
    credit: { kospi: credit.kospi, kosdaq: credit.kosdaq },
    history,
    errors,
  };
}

/** Read the last stored snapshot (null if none saved yet or no DB). */
export async function getStoredSnapshot(): Promise<MarketSnapshot | null> {
  if (!hasDb) return null;
  const rows = await db.select().from(settings).where(eq(settings.key, SNAPSHOT_KEY)).limit(1);
  if (rows.length === 0) return null;
  const snap = rows[0].value as unknown as MarketSnapshot;
  // Back-compat: snapshots stored before history/custom/credit existed.
  if (!snap.history) snap.history = { ...EMPTY_HISTORY };
  if (snap.history.custom === undefined) snap.history.custom = [];
  if (snap.history.creditKospi === undefined) snap.history.creditKospi = [];
  if (snap.history.creditKosdaq === undefined) snap.history.creditKosdaq = [];
  if (!snap.credit) snap.credit = { kospi: null, kosdaq: null };
  return snap;
}

/** Persist a snapshot under the settings KV key. */
export async function storeSnapshot(snap: MarketSnapshot): Promise<void> {
  if (!hasDb) return;
  const value = snap as unknown as Record<string, unknown>;
  await db
    .insert(settings)
    .values({ key: SNAPSHOT_KEY, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

/** Collect + persist, returning the new snapshot. */
export async function refreshMarketSnapshot(): Promise<MarketSnapshot> {
  const snap = await fetchMarketSnapshot();
  await storeSnapshot(snap);
  return snap;
}

/**
 * Change the configurable slot's symbol and re-collect JUST that symbol,
 * merging it into the stored snapshot (so we don't re-hit CNN/ADR/breadth).
 * Returns the updated snapshot.
 */
export async function setCustomSymbol(symbolInput: string): Promise<MarketSnapshot> {
  const input = symbolInput.trim();
  // The chart WS resolves bare tickers ("aapl" → "NASDAQ:AAPL"), so fetch with
  // the raw input and persist whatever canonical symbol it resolved to.
  const series = await fetchSymbol(input).catch(() => null);
  const ok = series && (series.quote || series.history.length > 0);
  const symbol = ok && series.resolved ? series.resolved : input.toUpperCase();
  await setCustomSymbolValue(symbol);

  const stored = (await getStoredSnapshot()) ?? (await refreshMarketSnapshot());
  stored.custom = { symbol, name: series?.name ?? null, quote: series?.quote ?? null };
  stored.history.custom = series?.history ?? [];
  // Drop a previous custom-symbol error (keep unrelated source errors).
  stored.errors = (stored.errors ?? []).filter((e) => !/찾지 못했습니다/.test(e));
  if (!ok) {
    stored.errors.push(`"${input}" 심볼을 찾지 못했습니다. 티커(예: AAPL) 또는 거래소:티커(예: NASDAQ:AAPL)로 입력하세요.`);
  }
  await storeSnapshot(stored);
  return stored;
}

/** TradingView resolution + bar count for each timeframe button. */
const TF_RES: Record<Timeframe, { res: string; count: number }> = {
  "4h": { res: "240", count: 360 },
  "1D": { res: "1D", count: 260 },
  "1W": { res: "1W", count: 260 },
  "1M": { res: "1M", count: 240 },
  "1Y": { res: "12M", count: 40 },
};

export interface CandlesResponse {
  symbol: string;
  name: string | null;
  timeframe: Timeframe;
  candles: OHLC[];
}

/** Live OHLC candles for the custom slot's candlestick chart (not stored). */
export async function getCandles(symbol: string, timeframe: Timeframe): Promise<CandlesResponse> {
  const { res, count } = TF_RES[timeframe];
  const r = await fetchCandles(symbol, res, count);
  return { symbol: r.resolved ?? symbol.toUpperCase(), name: r.name, timeframe, candles: r.candles };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
