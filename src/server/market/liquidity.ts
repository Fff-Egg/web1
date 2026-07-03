import type { LiquidityQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * US net-liquidity backdrop from FRED (free, no API key — the fredgraph.csv
 * endpoint serves any series as CSV, multiple ids at once).
 *
 *   net liquidity = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN)
 *
 * Plus reserve balances (WRESBAL) as a companion line. This is a SLOW, WEEKLY,
 * LAGGING macro-context gauge — the mechanism (Fed balance-sheet accounting
 * identity) is real, but it is NOT a timing signal: it decoupled hard from the
 * S&P during the 2023 AI rally. The card labels it as such.
 *
 * ⚠️ FRED unit quirk: WALCL / WTREGEN / WRESBAL are in **millions** of USD;
 * RRPONTSYD is in **billions**. All are normalized to $T (trillions) below.
 *
 * Frequency: WALCL/WTREGEN/WRESBAL are weekly (Wed level); RRPONTSYD is daily.
 * We build the net-liquidity series on WALCL's weekly dates, taking RRP as the
 * last known value on-or-before each date.
 */

const IDS = ["WALCL", "RRPONTSYD", "WTREGEN", "WRESBAL"] as const;
type SeriesId = (typeof IDS)[number];
const URL = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${IDS.join(",")}`;
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
  history: { netLiquidity: SeriesPoint[]; reserves: SeriesPoint[] };
}

export async function fetchLiquidity(timeoutMs = 20_000): Promise<LiquiditySnapshot> {
  const cosd = isoDate(new Date(Date.now() - 400 * 24 * 60 * 60_000));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let csv: string;
  try {
    const res = await fetch(`${URL}&cosd=${cosd}`, {
      headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`FRED fredgraph.csv HTTP ${res.status}`);
    csv = await res.text();
  } finally {
    clearTimeout(t);
  }

  // Parse: header = observation_date + the series ids (order not guaranteed).
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("FRED 응답이 비어 있습니다");
  const header = lines[0].split(",").map((h) => h.trim());
  const colOf = (id: SeriesId) => header.findIndex((h) => h.toUpperCase() === id);
  const idx: Record<SeriesId, number> = {
    WALCL: colOf("WALCL"),
    RRPONTSYD: colOf("RRPONTSYD"),
    WTREGEN: colOf("WTREGEN"),
    WRESBAL: colOf("WRESBAL"),
  };
  if (idx.WALCL < 0 || idx.WTREGEN < 0) {
    throw new Error("FRED 응답에 WALCL/WTREGEN 열이 없습니다");
  }

  // date(ms) → value(원 unit), per series (skip missing ".").
  const seriesMap: Record<SeriesId, Map<number, number>> = {
    WALCL: new Map(), RRPONTSYD: new Map(), WTREGEN: new Map(), WRESBAL: new Map(),
  };
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const ts = parseIso(cols[0]);
    if (ts === null) continue;
    for (const id of IDS) {
      const c = idx[id];
      if (c < 0) continue;
      const raw = cols[c]?.trim();
      if (!raw || raw === ".") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) seriesMap[id].set(ts, n / TO_TRILLIONS[id]); // → $T
    }
  }

  // RRP daily → sorted ascending, for last-known-on-or-before lookups.
  const rrpPts = [...seriesMap.RRPONTSYD.entries()].sort((a, b) => a[0] - b[0]);
  const rrpOnOrBefore = (ts: number): number => {
    let v = 0;
    for (const [t, val] of rrpPts) {
      if (t > ts) break;
      v = val;
    }
    return v;
  };

  // Net liquidity on WALCL's weekly dates.
  const netLiquidity: SeriesPoint[] = [];
  for (const [ts, walcl] of [...seriesMap.WALCL.entries()].sort((a, b) => a[0] - b[0])) {
    const tga = seriesMap.WTREGEN.get(ts);
    if (tga === undefined) continue;
    netLiquidity.push({ t: ts, v: round2(walcl - rrpOnOrBefore(ts) - tga) });
  }
  const reserves: SeriesPoint[] = [...seriesMap.WRESBAL.entries()]
    .map(([t, v]) => ({ t, v: round2(v) }))
    .sort((a, b) => a.t - b.t);

  const net = sliceLastYear(netLiquidity);
  const res = sliceLastYear(reserves);
  if (net.length === 0) throw new Error("FRED 순유동성 계산 결과가 비어 있습니다");

  const last = net[net.length - 1];
  const back4 = net.length > 4 ? net[net.length - 5] : null;
  const quote: LiquidityQuote = {
    net: last.v,
    net4wChange: back4 ? round2(last.v - back4.v) : null,
    reserves: res.length ? res[res.length - 1].v : null,
    rrp: rrpPts.length ? round2(rrpPts[rrpPts.length - 1][1]) : null,
    tga: lastVal(seriesMap.WTREGEN),
    asOf: new Date(last.t).toISOString(),
  };
  return { quote, history: { netLiquidity: net, reserves: res } };
}

function lastVal(m: Map<number, number>): number | null {
  const pts = [...m.entries()].sort((a, b) => a[0] - b[0]);
  return pts.length ? round2(pts[pts.length - 1][1]) : null;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function parseIso(s: string | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const [y, m, d] = s.trim().split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
