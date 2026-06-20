import type { CreditQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * 신용거래융자 잔고 (Korean margin-loan balance) for KOSPI / KOSDAQ.
 *
 * Source: KOFIA FreeSIS "신용공여 잔고 추이" (service STATSCU0100000070). This is the
 * authoritative market-level series — KRX's 정보데이터시스템 has no aggregate
 * credit-balance statistic, and Naver only publishes it per-stock.
 *
 * FreeSIS is a WebSquare/eXBuilder6 SPA, but its data flows through a plain-JSON
 * `/meta/getMetaDataList.do` gateway (the same `/meta/` family as getSrvData.do):
 * POST `{"dmSearch": {tmpV1: 자료주기, tmpV45/46: 조회기간, OBJ_NM: <data object>}}`
 * → `{"ds1": [{TMPV1: 일자, TMPV2: 신용융자전체, TMPV3: 유가증권(KOSPI),
 *             TMPV4: 코스닥(KOSDAQ), TMPV5-7: 신용대주, ...}]}` (values in 원).
 * Column mapping verified against the service's grid header definition
 * (H003=유가증권, H004=코스닥 under G001=신용거래융자; TMPV3+TMPV4==TMPV2).
 *
 * Values are returned in 조원 (trillion KRW): raw 원 / 1e12.
 */

const BASE = "https://freesis.kofia.or.kr";
const URL = `${BASE}/meta/getMetaDataList.do`;
const REFERER = `${BASE}/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070`;
/** Data object for 신용공여 잔고 추이 (from the service's getSrvData metadata). */
const OBJ_NM = "STATSCU0100000070BO";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const WON_PER_JO = 1e12;

export interface CreditSnapshot {
  kospi: CreditQuote | null;
  kosdaq: CreditQuote | null;
  history: { kospi: SeriesPoint[]; kosdaq: SeriesPoint[] };
}

interface CreditRow {
  /** Trading date, YYYYMMDD. */
  TMPV1?: string;
  /** 신용거래융자 유가증권(KOSPI), 원. */
  TMPV3?: number;
  /** 신용거래융자 코스닥(KOSDAQ), 원. */
  TMPV4?: number;
}

/**
 * Collect ~1 year of daily 신용거래융자 잔고 for KOSPI / KOSDAQ plus the latest value
 * per market. Tolerant — any failure throws, and the market collector records it in
 * `errors[]` (the card shows 데이터 없음).
 */
export async function fetchCreditSnapshot(timeoutMs = 20_000): Promise<CreditSnapshot> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 400 * 24 * 60 * 60_000));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let rows: CreditRow[];
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Referer: REFERER },
      // 자료주기 RD=일별, OBJ_NM = the credit-balance data object. tmpV40/41 are the
      // (unit) display params the form sends; the gateway accepts them inert.
      body: JSON.stringify({
        dmSearch: { tmpV1: "RD", tmpV45: from, tmpV46: to, OBJ_NM, tmpV40: "08", tmpV41: "1" },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`KOFIA getMetaDataList HTTP ${res.status}`);
    const json = (await res.json()) as { ds1?: CreditRow[] };
    rows = json.ds1 ?? [];
  } finally {
    clearTimeout(t);
  }

  if (rows.length === 0) {
    throw new Error("KOFIA 신용공여 잔고: 데이터가 비어 있습니다 (응답에 행 없음)");
  }

  const kospi: SeriesPoint[] = [];
  const kosdaq: SeriesPoint[] = [];
  for (const r of rows) {
    const ts = parseYmd(r.TMPV1);
    if (ts === null) continue;
    if (typeof r.TMPV3 === "number") kospi.push({ t: ts, v: r.TMPV3 / WON_PER_JO });
    if (typeof r.TMPV4 === "number") kosdaq.push({ t: ts, v: r.TMPV4 / WON_PER_JO });
  }
  // sliceLastYear also sorts ascending (the gateway returns newest-first).
  const ks = sliceLastYear(kospi);
  const kq = sliceLastYear(kosdaq);
  return { kospi: toQuote(ks), kosdaq: toQuote(kq), history: { kospi: ks, kosdaq: kq } };
}

/** Latest balance + previous day, from the tail of the (ascending) history. */
function toQuote(series: SeriesPoint[]): CreditQuote | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  return { value: last.v, prevValue: prev ? prev.v : null };
}

function parseYmd(s: string | undefined): number | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
