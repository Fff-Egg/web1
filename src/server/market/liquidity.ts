import type { LiquidityQuote, SeriesPoint } from "../../shared/market.js";
import { HISTORY_DAYS, sliceLastYear } from "../../shared/market.js";
import { fetchCloses } from "./tradingview.js";

/**
 * US net-liquidity backdrop:
 *
 *   net liquidity = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN)
 *
 * Plus reserve balances (WRESBAL) as a companion line. A SLOW, WEEKLY, LAGGING
 * macro-context gauge — NOT a timing signal (it decoupled hard from the S&P in
 * the 2023 AI rally). The card labels it as such.
 *
 * ⚠️ Source routing: fred.stlouisfed.org silently DROPS connections from
 * Railway's datacenter IPs (every series times out unanswered), so the PRIMARY
 * path is TradingView's chart WebSocket — it mirrors the full FRED catalog as
 * `FRED:<ID>` symbols and already works from Railway (S5FI/NDFI use the same
 * pipe). Direct FRED CSV is kept as a fallback for environments where it is
 * reachable. Note fredgraph.csv quirk: multi-id requests mixing frequencies
 * return a ZIP, so the fallback fetches one id per request.
 *
 * ⚠️ FRED unit quirk (verified against live CSV): WALCL / WTREGEN / WRESBAL are
 * in **millions** USD; RRPONTSYD is in **billions**. TradingView serves the same
 * raw units. All normalized to $T (trillions) below.
 */

const IDS = ["WALCL", "RRPONTSYD", "WTREGEN", "WRESBAL"] as const;
type SeriesId = (typeof IDS)[number];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** FRED unit → $T (trillions). WALCL/WTREGEN/WRESBAL: millions; RRPONTSYD: billions. */
const TO_TRILLIONS: Record<SeriesId, number> = {
  WALCL: 1e6,
  WTREGEN: 1e6,
  WRESBAL: 1e6,
  RRPONTSYD: 1e3,
};

export interface LiquiditySnapshot {
  quote: LiquidityQuote | null;
  history: { netLiquidity: SeriesPoint[]; reserves: SeriesPoint[]; tga: SeriesPoint[]; rrp: SeriesPoint[] };
  /** Per-series failure notes (Korean) — partial failures must be VISIBLE:
   *  e.g. an all-failed RRP would otherwise silently zero out of the net calc. */
  errors: string[];
}

/** TV mirror symbols per FRED id, tried in order (first with data wins). TGA
 *  keeps a daily alternate (WDTGAL) in case the weekly WTREGEN mirror is
 *  unavailable/empty on the anonymous feed. */
const TV_SYMBOLS: Record<SeriesId, string[]> = {
  WALCL: ["FRED:WALCL"],
  RRPONTSYD: ["FRED:RRPONTSYD"],
  WTREGEN: ["FRED:WTREGEN", "FRED:WDTGAL"],
  WRESBAL: ["FRED:WRESBAL"],
};

/**
 * Primary: TradingView chart WS (`FRED:<id>`), raw closes → $T map.
 * ⚠️ TradingView serves these FRED series in **actual dollars** (not FRED's
 * millions/billions), so everything divides by 1e12 to reach $T. Non-positive
 * closes (placeholder/empty bars) are dropped — these levels are always large & positive.
 */
async function fetchViaTradingView(id: SeriesId, timeoutMs: number): Promise<Map<number, number>> {
  for (const sym of TV_SYMBOLS[id]) {
    const closes = await fetchCloses(sym, timeoutMs);
    const out = new Map<number, number>();
    for (const p of closes) {
      if (Number.isFinite(p.v) && p.v > 0) out.set(p.t, p.v / 1e12);
    }
    if (out.size > 0) return out;
  }
  return new Map<number, number>();
}

/** Fallback: direct FRED single-id CSV (plain CSV only when one id per request). */
async function fetchViaFredCsv(id: SeriesId, timeoutMs: number): Promise<Map<number, number>> {
  // Same depth as the primary TV path (~5y) so the 월/년 toggles don't shrink
  // when this fallback is the one that answered.
  const cosd = isoDate(new Date(Date.now() - (HISTORY_DAYS + 30) * 24 * 60 * 60_000));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let csv: string;
  try {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, {
      headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    csv = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message))) {
      throw new Error(`FRED 타임아웃(${Math.round(timeoutMs / 1000)}초 무응답)`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (csv.startsWith("PK")) throw new Error("FRED: 예상치 못한 ZIP 응답");

  const out = new Map<number, number>();
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [dateStr, valStr] = lines[i].split(",");
    const ts = parseIso(dateStr);
    if (ts === null) continue;
    const raw = valStr?.trim();
    if (!raw || raw === ".") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.set(ts, n / TO_TRILLIONS[id]);
  }
  return out;
}

/** One series: TradingView first (works from Railway), FRED CSV as fallback. */
async function fetchSeries(id: SeriesId, timeoutMs: number): Promise<Map<number, number>> {
  const tv = await fetchViaTradingView(id, timeoutMs).catch(() => new Map<number, number>());
  if (tv.size > 0) return tv;
  try {
    return await fetchViaFredCsv(id, timeoutMs);
  } catch (e) {
    throw new Error(`TradingView 응답 없음 + ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function fetchLiquidity(timeoutMs = 22_000): Promise<LiquiditySnapshot> {
  // Two at a time: the snapshot batch already opens 3 anonymous TV connections
  // (S5FI/NDFI/custom); keep the total burst modest to avoid rate limits.
  const fails: string[] = [];
  const get = (id: SeriesId) =>
    fetchSeries(id, timeoutMs).catch((e: unknown) => {
      fails.push(`${id} ${e instanceof Error ? e.message : String(e)}`);
      return new Map<number, number>();
    });
  const [walcl, tga] = await Promise.all([get("WALCL"), get("WTREGEN")]);
  const [rrpMap, wresbal] = await Promise.all([get("RRPONTSYD"), get("WRESBAL")]);
  // Only a TOTAL wipeout is fatal. If even one driver survived we return a
  // partial card (its own chart), rather than blanking the whole thing — one
  // dead series (e.g. TGA) used to take reserves/RRP down with it.
  if (walcl.size === 0 && tga.size === 0 && rrpMap.size === 0 && wresbal.size === 0) {
    throw new Error(fails.length ? fails.join(" · ") : "모든 시리즈 응답이 비어 있음");
  }

  // Sorted point lists for carry-forward lookups. TGA/RRP values are taken as
  // the last known value on-or-before each WALCL date — robust to the small
  // date/timezone misalignments between TV bars and FRED weekly observations.
  const tgaPts = [...tga.entries()].sort((a, b) => a[0] - b[0]);
  const rrpPts = [...rrpMap.entries()].sort((a, b) => a[0] - b[0]);
  const lastOnOrBefore = (pts: [number, number][], ts: number): number | null => {
    let v: number | null = null;
    for (const [t, val] of pts) {
      if (t > ts) break;
      v = val;
    }
    return v;
  };

  // Net liquidity needs BOTH WALCL and TGA; if either is missing we skip it and
  // still return the driver charts. TV weekly series carry ~1300 bars ≈ 25 years
  // — skip everything sliceLastYear would drop anyway instead of computing it.
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60_000;
  const netLiquidity: SeriesPoint[] = [];
  if (walcl.size > 0 && tgaPts.length > 0) {
    for (const [ts, wa] of [...walcl.entries()].sort((a, b) => a[0] - b[0])) {
      if (ts < cutoff) continue;
      const tg = lastOnOrBefore(tgaPts, ts);
      if (tg === null) continue; // before the first TGA observation
      const rrp = lastOnOrBefore(rrpPts, ts) ?? 0;
      netLiquidity.push({ t: ts, v: round2(wa - rrp - tg) });
    }
  }
  const reserves: SeriesPoint[] = [...wresbal.entries()]
    .map(([t, v]) => ({ t, v: round2(v) }))
    .sort((a, b) => a.t - b.t);

  const net = sliceLastYear(netLiquidity);
  const res = sliceLastYear(reserves);
  const tgaHist = sliceLastYear(tgaPts.map(([t, v]) => ({ t, v: round2(v) })));
  // RRP sits at ~$0.00x T in 2026 — round2 ($10B grid) would flatten it while the
  // chart renders 3 decimals, so RRP alone keeps 3.
  const rrpHist = sliceLastYear(rrpPts.map(([t, v]) => ({ t, v: round3(v) })));

  const lastNet = net.length ? net[net.length - 1] : null;
  const back4 = net.length > 4 ? net[net.length - 5] : null;
  // As-of falls back to whichever driver did land, so the "기준" date still shows.
  const asOfTs = lastNet?.t ?? res.at(-1)?.t ?? tgaHist.at(-1)?.t ?? rrpHist.at(-1)?.t ?? null;
  const quote: LiquidityQuote = {
    net: lastNet ? lastNet.v : null,
    net4wChange: lastNet && back4 ? round2(lastNet.v - back4.v) : null,
    reserves: res.length ? res[res.length - 1].v : null,
    rrp: rrpPts.length ? round3(rrpPts[rrpPts.length - 1][1]) : null,
    tga: tgaPts.length ? round2(tgaPts[tgaPts.length - 1][1]) : null,
    asOf: asOfTs ? new Date(asOfTs).toISOString() : null,
  };
  return { quote, history: { netLiquidity: net, reserves: res, tga: tgaHist, rrp: rrpHist }, errors: fails };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function parseIso(s: string | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const [y, m, d] = s.trim().split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
