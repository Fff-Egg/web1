import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { MarketSnapshot, MarketHistory } from "../../shared/market.js";
import { fetchFearGreed } from "./cnn.js";
import { fetchBreadth } from "./tradingview.js";
import { fetchAdr, fetchAdrHistory } from "./adr.js";

const SNAPSHOT_KEY = "marketSnapshot";

const EMPTY_HISTORY: MarketHistory = {
  fearGreed: [],
  s5fi: [],
  ndfi: [],
  kospiAdr: [],
  kosdaqAdr: [],
};

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

  const [fg, breadth, adr, adrHist] = await Promise.all([
    fetchFearGreed().catch((e: unknown) => {
      errors.push(`Fear & Greed 수집 실패: ${msg(e)}`);
      return null;
    }),
    fetchBreadth().catch((e: unknown) => {
      errors.push(`S5FI/NDFI 수집 실패: ${msg(e)}`);
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
  history.kospiAdr = adrHist.kospi;
  history.kosdaqAdr = adrHist.kosdaq;

  return {
    fetchedAt: new Date().toISOString(),
    fearGreed: fg ? fg.current : null,
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
  // Back-compat: snapshots stored before history existed.
  if (!snap.history) snap.history = { ...EMPTY_HISTORY };
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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
