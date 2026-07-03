import type { LiquidityQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * US net-liquidity backdrop from FRED (free, no API key).
 *
 *   net liquidity = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN)
 *
 * Plus reserve balances (WRESBAL) as a companion line. A SLOW, WEEKLY, LAGGING
 * macro-context gauge — NOT a timing signal (it decoupled hard from the S&P in
 * the 2023 AI rally). The card labels it as such.
 *
 * ⚠️ Each series is fetched INDIVIDUALLY. FRED's fredgraph.csv bundles a
 * multi-id request into a ZIP (separate CSVs per frequency) whenever the ids mix
 * frequencies — and these do (RRPONTSYD is daily; the others are weekly). A
 * single-id request always returns a plain CSV, so we fetch one series each and
 * combine. Bonus: one dead series no longer kills the rest.
 *
 * ⚠️ FRED unit quirk: WALCL / WTREGEN / WRESBAL are in **millions** of USD;
 * RRPONTSYD is in **billions**. All normalized to $T (trillions) below.
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
  history: { netLiquidity: SeriesPoint[]; reserves: SeriesPoint[] };
}

/** Fetch one FRED series as a plain single-column CSV → date(ms) → value ($T). */
async function fetchSeries(id: SeriesId, cosd: string, timeoutMs: number): Promise<Map<number, number>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let csv: string;
  try {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, {
      headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
    csv = await res.text();
  } finally {
    clearTimeout(t);
  }
  if (csv.startsWith("PK")) throw new Error(`FRED ${id}: 예상치 못한 ZIP 응답 (단일 시리즈 요청 필요)`);

  const out = new Map<number, number>();
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [dateStr, valStr] = lines[i].split(",");
    const ts = parseIso(dateStr);
    if (ts === null) continue;
    const raw = valStr?.trim();
    if (!raw || raw === ".") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.set(ts, n / TO_TRILLIONS[id]); // → $T
  }
  return out;
}

export async function fetchLiquidity(timeoutMs = 20_000): Promise<LiquiditySnapshot> {
  const cosd = isoDate(new Date(Date.now() - 400 * 24 * 60 * 60_000));

  // WALCL + WTREGEN are required (net can't be computed without them); RRP and
  // WRESBAL are optional (a missing one just leaves reserves/rrp null or RRP=0).
  const [walcl, tga, rrpMap, wresbal] = await Promise.all([
    fetchSeries("WALCL", cosd, timeoutMs),
    fetchSeries("WTREGEN", cosd, timeoutMs),
    fetchSeries("RRPONTSYD", cosd, timeoutMs).catch(() => new Map<number, number>()),
    fetchSeries("WRESBAL", cosd, timeoutMs).catch(() => new Map<number, number>()),
  ]);

  // RRP daily → sorted ascending, for last-known-on-or-before lookups.
  const rrpPts = [...rrpMap.entries()].sort((a, b) => a[0] - b[0]);
  const rrpOnOrBefore = (ts: number): number => {
    let v = 0;
    for (const [t, val] of rrpPts) {
      if (t > ts) break;
      v = val;
    }
    return v;
  };

  // Net liquidity on WALCL's weekly dates (need a matching TGA point).
  const netLiquidity: SeriesPoint[] = [];
  for (const [ts, wa] of [...walcl.entries()].sort((a, b) => a[0] - b[0])) {
    const tg = tga.get(ts);
    if (tg === undefined) continue;
    netLiquidity.push({ t: ts, v: round2(wa - rrpOnOrBefore(ts) - tg) });
  }
  const reserves: SeriesPoint[] = [...wresbal.entries()]
    .map(([t, v]) => ({ t, v: round2(v) }))
    .sort((a, b) => a.t - b.t);

  const net = sliceLastYear(netLiquidity);
  const res = sliceLastYear(reserves);
  if (net.length === 0) throw new Error("FRED 순유동성 계산 결과가 비어 있습니다 (WALCL/TGA 날짜 불일치)");

  const last = net[net.length - 1];
  const back4 = net.length > 4 ? net[net.length - 5] : null;
  const quote: LiquidityQuote = {
    net: last.v,
    net4wChange: back4 ? round2(last.v - back4.v) : null,
    reserves: res.length ? res[res.length - 1].v : null,
    rrp: rrpPts.length ? round2(rrpPts[rrpPts.length - 1][1]) : null,
    tga: lastVal(tga),
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
