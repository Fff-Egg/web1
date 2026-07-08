import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { assertAnchor } from "./anchors.js";

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

// FEAR's F2 (반대매매 분위수) needs a 252-day rolling window; keep ~1200 calendar
// days (~820 trading) so it isn't the series that starves the FEAR history chart.
const DAYS = 1200;

export async function fetchForcedLiqRatio(timeoutMs = 20_000): Promise<SeriesPoint[]> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - DAYS * 24 * 60 * 60_000));

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

  // Column identity is ANCHOR-PINNED, not guessed: 미수금대비 반대매매 비중 on
  // 2026-07-07 is 2.2 (verified vs the KOFIA screen). Pick the column whose 07-07
  // value ≈ 2.2 — this survives KOFIA reordering/renaming columns (the median
  // heuristic would silently follow a moved column). We scan TMPV7 first, then any
  // other TMPV field, so it's robust to position. Fallback (if 07-07 isn't in the
  // window — e.g. a far-future query) is the median-plausibility gate: median in
  // [0,30] keeps big capitulation spikes that an every-row `<=30` gate would reject.
  const anchorRow = rows.find((r) => r.TMPV1 === "20260707");
  const near22 = (r: Row, k: string) => {
    const v = num(r[k]);
    return v !== null && Math.abs(v - 2.2) < 0.5;
  };
  const medianPlausible = (k: string) => {
    const vals = rows.map((r) => num(r[k])).filter((v): v is number => v !== null);
    if (vals.length < rows.length * 0.5) return false;
    const median = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    return median >= 0 && median <= 30;
  };
  let ratioKey: string | undefined;
  let how = "";
  if (anchorRow) {
    const cols = [...RATIO_KEYS, ...Object.keys(anchorRow).filter((k) => k.startsWith("TMPV") && k !== "TMPV1")];
    ratioKey = cols.find((k) => near22(anchorRow, k));
    if (ratioKey) how = "앵커(07-07=2.2) 매칭";
  }
  if (!ratioKey) {
    // 앵커 날짜가 창 밖일 때(먼 미래)의 폴백. 컬럼 재정렬에도 견고하도록 RATIO_KEYS만이
    // 아니라 응답의 모든 TMPV* 컬럼을 중앙값으로 스캔한다.
    const allCols = [...RATIO_KEYS, ...Object.keys(rows[0] ?? {}).filter((k) => k.startsWith("TMPV") && k !== "TMPV1")];
    ratioKey = allCols.find(medianPlausible);
    if (ratioKey) how = "중앙값 폴백(전 TMPV 스캔·앵커 날짜 없음)";
  }
  console.log(`[forcedLiq] 반대매매 컬럼 = ${ratioKey ?? "식별 실패"} (${how || "실패"})`);
  if (!ratioKey) throw new Error("KOFIA 증시자금: 반대매매 비중 컬럼을 식별하지 못함 (컬럼 매핑 필요)");

  const out: SeriesPoint[] = [];
  for (const r of rows) {
    const ts = parseYmd(r.TMPV1);
    const v = num(r[ratioKey]);
    // Keep any real ratio (incl. big spikes); drop only parse garbage / 원-scale.
    if (ts !== null && v !== null && v >= 0 && v <= 100) out.push({ t: ts, v: Math.round(v * 100) / 100 });
  }
  const sliced = sliceLastYear(out, DAYS);
  // HARD 앵커: 고른 컬럼이 진짜 반대매매 비중인지 실측값으로 검문. TMPV 컬럼이 이동해
  // 엉뚱한 값(예: 미수금 금액)이 들어오면 throw → 반대매매 통째 거부(S2가 망가진 채
  // 화면에 안 뜸). 2026-07-07 = 2.2% (KOFIA 실화면). 그 날짜가 창에 없으면 no-op.
  assertAnchor(sliced, 2026, 7, 7, 2.2, 0.2, 0, "반대매매 비중(%)");
  return sliced;
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
