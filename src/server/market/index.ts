import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { MarketSnapshot, MarketHistory } from "../../shared/market.js";
import { fetchFearGreed } from "./cnn.js";
import { fetchBreadth, fetchSymbol } from "./tradingview.js";
import { fetchAdr, fetchAdrHistory } from "./adr.js";

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

  const [fg, breadth, custom, adr, adrHist] = await Promise.all([
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
  ]);

  if (fg) history.fearGreed = fg.history;
  if (breadth) {
    history.s5fi = breadth.s5fi.history;
    history.ndfi = breadth.ndfi.history;
  }
  if (custom) history.custom = custom.history;
  history.kospiAdr = adrHist.kospi;
  history.kosdaqAdr = adrHist.kosdaq;

  return {
    fetchedAt: new Date().toISOString(),
    fearGreed: fg ? fg.current : null,
    custom: { symbol: customSymbol, name: custom?.name ?? null, quote: custom?.quote ?? null },
    breadth: {
      s5fi: breadth ? breadth.s5fi.quote : null,
      ndfi: breadth ? breadth.ndfi.quote : null,
    },
    adr,
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
  // Back-compat: snapshots stored before history/custom existed.
  if (!snap.history) snap.history = { ...EMPTY_HISTORY };
  if (snap.history.custom === undefined) snap.history.custom = [];
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
  const symbol = symbolInput.trim().toUpperCase();
  await setCustomSymbolValue(symbol);

  const series = await fetchSymbol(symbol).catch(() => null);
  const stored = (await getStoredSnapshot()) ?? (await refreshMarketSnapshot());

  stored.custom = { symbol, name: series?.name ?? null, quote: series?.quote ?? null };
  stored.history.custom = series?.history ?? [];
  // Drop a previous custom-symbol error (keep unrelated source errors).
  stored.errors = (stored.errors ?? []).filter((e) => !/심볼 형식을 확인/.test(e));
  if (!series || (!series.quote && series.history.length === 0)) {
    stored.errors.push(`${symbol}: 데이터를 받지 못했습니다. 심볼 형식을 확인하세요 (예: NASDAQ:AAPL).`);
  }
  await storeSnapshot(stored);
  return stored;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
