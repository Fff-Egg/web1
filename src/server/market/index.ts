import { eq } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { MarketSnapshot } from "../../shared/market.js";
import { fetchFearGreed } from "./cnn.js";
import { fetchBreadth } from "./tradingview.js";
import { fetchAdr } from "./adr.js";

const SNAPSHOT_KEY = "marketSnapshot";

/**
 * Collect a fresh snapshot from all three sources in parallel. Each source is
 * independent and tolerant: a failure records a Korean note in `errors` and
 * leaves that section null, so a single dead source never blocks the others.
 */
export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const errors: string[] = [];

  const [fg, breadth, adr] = await Promise.all([
    fetchFearGreed().catch((e: unknown) => {
      errors.push(`Fear & Greed 수집 실패: ${msg(e)}`);
      return null;
    }),
    fetchBreadth().catch((e: unknown) => {
      errors.push(`S5FI/NDFI 수집 실패: ${msg(e)}`);
      return { s5fi: null, ndfi: null };
    }),
    fetchAdr().catch((e: unknown) => {
      errors.push(`ADR(코스피/코스닥) 수집 실패: ${msg(e)}`);
      return { kospi: null, kosdaq: null };
    }),
  ]);

  if (breadth.s5fi === null && breadth.ndfi === null && !errors.some((e) => e.startsWith("S5FI")))
    errors.push("S5FI/NDFI: 값을 받지 못했습니다.");

  return {
    fetchedAt: new Date().toISOString(),
    fearGreed: fg,
    breadth,
    adr,
    errors,
  };
}

/** Read the last stored snapshot (null if none saved yet or no DB). */
export async function getStoredSnapshot(): Promise<MarketSnapshot | null> {
  if (!hasDb) return null;
  const rows = await db.select().from(settings).where(eq(settings.key, SNAPSHOT_KEY)).limit(1);
  if (rows.length === 0) return null;
  return rows[0].value as unknown as MarketSnapshot;
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
