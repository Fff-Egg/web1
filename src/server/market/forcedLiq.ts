import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * 미수 반대매매 비중 (unpaid-balance forced-liquidation ratio, %) — the public,
 * daily proxy for forced selling. Source: KOFIA FreeSIS "증시자금 추이"
 * (service STATSCU0100000060, same /meta/getMetaDataList.do gateway as the
 * credit-balance collector). The screen carries 투자자예탁금 · 미수금 ·
 * 반대매매금액 · 미수금대비 반대매매 비중.
 *
 * ⚠️ The exact TMPV column for the ratio is UNVERIFIED (KOFIA is unreachable from
 * the sandbox). We take a documented-guess column, gate it to a plausible
 * percentage range (0–30%), and log the first row's raw keys so the mapping can
 * be corrected from Railway's real response. If the guess is wrong the series
 * comes back empty → the panel shows "데이터 없음" rather than fabricated numbers.
 */

const BASE = "https://freesis.kofia.or.kr";
const URL = `${BASE}/meta/getMetaDataList.do`;
const REFERER = `${BASE}/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000060`;
const OBJ_NM = "STATSCU0100000060BO";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Candidate columns for 미수금대비 반대매매 비중(%), most-likely first. */
const RATIO_KEYS = ["TMPV7", "TMPV6", "TMPV5"];

interface Row {
  TMPV1?: string; // 일자 YYYYMMDD
  [key: string]: unknown;
}

export async function fetchForcedLiqRatio(timeoutMs = 20_000): Promise<SeriesPoint[]> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 500 * 24 * 60 * 60_000));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let rows: Row[];
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Referer: REFERER },
      body: JSON.stringify({ dmSearch: { tmpV1: "RD", tmpV45: from, tmpV46: to, OBJ_NM, tmpV40: "08", tmpV41: "1" } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`KOFIA 증시자금 HTTP ${res.status}`);
    const json = (await res.json()) as { ds1?: Row[] };
    rows = json.ds1 ?? [];
  } finally {
    clearTimeout(t);
  }
  if (rows.length === 0) throw new Error("KOFIA 증시자금: 응답에 행 없음");

  // One-time hint for mapping: dump the columns we actually got.
  console.log(`[forcedLiq] KOFIA 증시자금 첫 행 키:`, JSON.stringify(rows[0]).slice(0, 400));

  // Pick the first candidate column whose values look like a percentage.
  const plausible = (k: string) =>
    rows.filter((r) => typeof num(r[k]) === "number").length > rows.length * 0.5 &&
    rows.every((r) => {
      const v = num(r[k]);
      return v === null || (v >= 0 && v <= 30);
    });
  const ratioKey = RATIO_KEYS.find(plausible);
  if (!ratioKey) throw new Error("KOFIA 증시자금: 반대매매 비중 컬럼을 식별하지 못함 (컬럼 매핑 필요)");

  const out: SeriesPoint[] = [];
  for (const r of rows) {
    const ts = parseYmd(r.TMPV1);
    const v = num(r[ratioKey]);
    if (ts !== null && v !== null) out.push({ t: ts, v: Math.round(v * 100) / 100 });
  }
  return sliceLastYear(out, 500);
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function parseYmd(s: string | undefined): number | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}
function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
