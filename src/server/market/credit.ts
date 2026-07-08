import type { CreditQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { assertAnchor } from "./anchors.js";

/**
 * 신용거래융자 잔고 (Korean margin-loan balance) for KOSPI / KOSDAQ.
 *
 * Source: KOFIA FreeSIS "신용공여 잔고 추이" (service STATSCU0100000070). This is the
 * authoritative market-level series — KRX's 정보데이터시스템 has no aggregate
 * credit-balance statistic, and Naver only publishes it per-stock.
 *
 * FreeSIS is a WebSquare SPA whose data flows through a plain-JSON
 * `/meta/getMetaDataList.do` gateway:
 * POST `{"dmSearch": {tmpV1: 자료주기, tmpV45/46: 조회기간, OBJ_NM: <data object>}}`
 * → `{"ds1": [{TMPV1: 일자, ...}]}`. Columns, verified value-by-value against the
 * live 신용공여잔고추이 grid (2026-07-07):
 *   TMPV2/3/4 = 신용거래융자 전체 / 유가증권 / 코스닥   ← 이게 "신용잔고"
 *   TMPV5/6/7 = 신용거래대주 전체 / 유가증권 / 코스닥
 *   TMPV8     = 청약자금대출,   TMPV9 = 예탁증권담보융자
 *
 * ⚠️ SCALE: the gateway returns every balance at exactly 1/8 of the real 원 value
 * (TMPV3 3.634e12 → screen 유가증권 29.07조 = ×8; the ratio holds for every column
 * and date, so it's a uniform display-scale artifact of the tmpV40/41 params, not
 * a per-column error). We multiply back by 8, then / 1e12 to reach 조원.
 */

const BASE = "https://freesis.kofia.or.kr";
const URL = `${BASE}/meta/getMetaDataList.do`;
const REFERER = `${BASE}/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070`;
/** Data object for 신용공여 잔고 추이 (from the service's getSrvData metadata). */
const OBJ_NM = "STATSCU0100000070BO";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
/** getMetaDataList returns balances at 1/8 of the actual 원 value (measured
 *  against the FreeSIS screen — see header). Multiply back, then / 1e12 → 조원. */
const KOFIA_UNIT_FACTOR = 8;
const TO_JO = 1e12 / KOFIA_UNIT_FACTOR; // API 단위 → 조원 (= 1.25e11)

export interface CreditSnapshot {
  kospi: CreditQuote | null;
  kosdaq: CreditQuote | null;
  history: { kospi: SeriesPoint[]; kosdaq: SeriesPoint[] };
}

interface CreditRow {
  /** Trading date, YYYYMMDD. */
  TMPV1?: string;
  /** 신용거래융자 유가증권(KOSPI), 1/8-scaled 원 (see KOFIA_UNIT_FACTOR). */
  TMPV3?: number;
  /** 신용거래융자 코스닥(KOSDAQ), 1/8-scaled 원. */
  TMPV4?: number;
}

/**
 * Collect ~1 year of daily 신용거래융자 잔고 for KOSPI / KOSDAQ plus the latest value
 * per market. Tolerant — any failure throws, and the market collector records it in
 * `errors[]` (the card shows 데이터 없음).
 */
export async function fetchCreditSnapshot(timeoutMs = 20_000): Promise<CreditSnapshot> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 1850 * 24 * 60 * 60_000));

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

  // 다날짜 ×8 교차검증 로그(게이트웨이 newest-first라 최신 6일). 실화면 백만원과 대조:
  // 2026-07-07 유가 29.075조, 2026-06-24 전체(유가+코스닥) 38.633조여야 한다.
  for (const r of rows.slice(0, 6)) {
    const k = typeof r.TMPV3 === "number" ? (r.TMPV3 / TO_JO).toFixed(3) : "-";
    const q = typeof r.TMPV4 === "number" ? (r.TMPV4 / TO_JO).toFixed(3) : "-";
    const tot = typeof r.TMPV3 === "number" && typeof r.TMPV4 === "number" ? ((r.TMPV3 + r.TMPV4) / TO_JO).toFixed(3) : "-";
    console.log(`[credit] ${r.TMPV1}: 유가 ${k}조 · 코스닥 ${q}조 · 전체 ${tot}조 (×8 보정)`);
  }

  const kospi: SeriesPoint[] = [];
  const kosdaq: SeriesPoint[] = [];
  for (const r of rows) {
    const ts = parseYmd(r.TMPV1);
    if (ts === null) continue;
    if (typeof r.TMPV3 === "number") kospi.push({ t: ts, v: r.TMPV3 / TO_JO });
    if (typeof r.TMPV4 === "number") kosdaq.push({ t: ts, v: r.TMPV4 / TO_JO });
  }
  // sliceLastYear also sorts ascending (the gateway returns newest-first).
  const ks = sliceLastYear(kospi);
  const kq = sliceLastYear(kosdaq);
  // HARD 앵커: ×8 보정이 맞는지 실측값으로 검문. 게이트웨이가 배수를 바꾸거나(1배 복귀
  // 등) 컬럼이 이동하면 여기서 throw → 신용잔고를 통째 거부(8배 뻥튀기가 화면에 안 뜸).
  // 2026-07-07 유가 = 29.074973조 (KOFIA 실화면 대조). 그 날짜가 창에 없으면 no-op.
  assertAnchor(ks, 2026, 7, 7, 29.074973, 0.05, 0, "신용융자 유가(조)");
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
