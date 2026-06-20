import type { CreditQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * 신용거래융자 잔고 (Korean margin-loan balance) for KOSPI / KOSDAQ.
 *
 * Source: KOFIA FreeSIS "신용공여 잔고 추이" (service STATSCU0100000070). This is the
 * authoritative market-level series — KRX's 정보데이터시스템 has no aggregate
 * credit-balance statistic, and Naver only publishes it per-stock. The grid is
 * 신용거래융자 split into 전체 / 유가증권(KOSPI) / 코스닥, daily, in 원, since 2002.
 *
 * The FreeSIS portal is a WebSquare/eXBuilder6 (cleopatra) SPA. Its metadata API
 * (`/meta/getMenuData.do`, `/meta/getSrvData.do`) speaks plain JSON, but the actual
 * time series flows through the `/CommSubmit/egovXbuilder.do` gateway using the
 * framework's proprietary URL-encoded dataset transfer format (reproduced in
 * `encodeDatasets` below). The metadata calls confirm the service + the latest
 * trading date; the gateway call returns the rows.
 *
 * Values are returned in 조원 (trillion KRW): raw 원 / 1e12.
 */

const BASE = "https://freesis.kofia.or.kr";
const REFERER = `${BASE}/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000070`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Service + data-object identifiers for 신용공여 잔고 추이 (from getSrvData). */
const SERVICE_ID = "STATSCU0100000070";
const PARENT_DIV = "MSIS10000000000000";

const WON_PER_JO = 1e12;

export interface CreditSnapshot {
  kospi: CreditQuote | null;
  kosdaq: CreditQuote | null;
  history: { kospi: SeriesPoint[]; kosdaq: SeriesPoint[] };
}

/** One DataSet/DataMap for the eXBuilder6 form-urlencoded request. */
interface Dataset {
  id: string;
  /** "ds" (DataSet, many rows) or "dm" (DataMap, single row). */
  type: "ds" | "dm";
  rows: Record<string, string>[];
}

/**
 * Reproduce cleopatra's `URLEncodedRequestBuilder` body for a set of request
 * datasets. Each dataset gets a prefix `@dN#`; per row it emits `@dN#<col>=<val>`
 * plus `@dN#sts=<state>`; then `@d#=@dN#` (the dataset list), `@dN#=<id>` (prefix→id)
 * and `@dN#tp=ds|dm`. Row state defaults to "i" (inserted). Verified against the
 * minified cleopatra.js encoder (DefaultRequestBuilderFactory → URLEncodedRequestBuilder).
 */
function encodeDatasets(datasets: Dataset[]): string {
  const enc = (s: string) => encodeURIComponent(s);
  const parts: string[] = [];
  datasets.forEach((ds, i) => {
    const h = `@d${i + 1}#`;
    for (const row of ds.rows) {
      for (const [col, val] of Object.entries(row)) parts.push(`${enc(h + col)}=${enc(val ?? "")}`);
      parts.push(`${enc(h + "sts")}=${enc("i")}`);
    }
    parts.push(`${enc("@d#")}=${enc(h)}`);
    parts.push(`${enc(h)}=${enc(ds.id)}`);
    parts.push(`${enc(h + "tp")}=${ds.type}`);
  });
  return parts.join("&");
}

async function postForm(url: string, body: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Referer: REFERER,
        Origin: BASE,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`KOFIA ${url} HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Referer: REFERER },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`KOFIA ${url} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Confirm the service is reachable and read its latest daily trading date (YYYYMMDD). */
async function fetchLatestDate(timeoutMs: number): Promise<string | null> {
  const data = (await postJson(
    `${BASE}/meta/getSrvData.do`,
    {
      dmSearchData: {
        strSvrId: SERVICE_ID,
        strDivId: PARENT_DIV,
        app_peron_yn: "Y",
        language_gb: "KOR",
        strGetCode: "N",
      },
    },
    timeoutMs,
  )) as { dsLatestDate?: { TMPV1?: string; TMPV2?: string }[] };
  const daily = data.dsLatestDate?.find((r) => r.TMPV1 === "RD");
  return daily?.TMPV2 ?? null;
}

/**
 * Fetch the daily 신용거래융자 잔고 rows for [from, to] via the eXBuilder6 gateway.
 * Returns the per-market history (조원), most recent last. Throws if the gateway
 * yields no parseable rows (the current state from server-side HTTP — see the
 * module note; a request captured from the live page completes this).
 */
async function fetchCreditRows(
  from: string,
  to: string,
  timeoutMs: number,
): Promise<{ kospi: SeriesPoint[]; kosdaq: SeriesPoint[] }> {
  const body = encodeDatasets([
    { id: "dsParam", type: "ds", rows: [{ tmpV1: "RD", tmpV45: from, tmpV46: to }] },
    {
      id: "dsCommExbuilderParam",
      type: "ds",
      rows: [
        {
          MAPPER: "kf.stat.divscu.dbio.STATSCU0100000070",
          QRY: "VM0",
          TYPE: "R",
          IN_DS: "",
          OUT_DS: "ds1",
          OUT_DS_TYPE: "ds",
          REQ_PARAM: "dsParam",
        },
      ],
    },
  ]);
  const text = await postForm(`${BASE}/CommSubmit/egovXbuilder.do`, body, timeoutMs);
  return parseCreditResponse(text);
}

/**
 * Parse the gateway response into per-market series. Handles a plain-JSON shape
 * (rows with a date + 유가증권/코스닥 credit columns) if the gateway returns one;
 * otherwise yields nothing (the eXBuilder6 binary-ish encoding is not decoded here
 * yet). Date keys/column names are matched leniently so a captured sample can be
 * dropped in without code churn.
 */
function parseCreditResponse(text: string): { kospi: SeriesPoint[]; kosdaq: SeriesPoint[] } {
  const kospi: SeriesPoint[] = [];
  const kosdaq: SeriesPoint[] = [];
  let rows: Record<string, unknown>[] = [];
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const arr = (json.ds1 ?? json.dsList ?? json.dsGrid ?? Object.values(json).find(Array.isArray)) as unknown;
    if (Array.isArray(arr)) rows = arr as Record<string, unknown>[];
  } catch {
    return { kospi, kosdaq };
  }
  for (const r of rows) {
    const t = parseDateKey(r);
    if (t === null) continue;
    const ks = pickNumber(r, ["KOSPI", "유가증권", "STK", "C1"]);
    const kq = pickNumber(r, ["KOSDAQ", "코스닥", "KSQ", "C2"]);
    if (ks !== null) kospi.push({ t, v: ks / WON_PER_JO });
    if (kq !== null) kosdaq.push({ t, v: kq / WON_PER_JO });
  }
  return { kospi: sliceLastYear(kospi), kosdaq: sliceLastYear(kosdaq) };
}

function parseDateKey(r: Record<string, unknown>): number | null {
  for (const k of ["TRD_DT", "DT", "BAS_DT", "C0", "STD_DT", "date", "TMPV1"]) {
    const v = r[k];
    if (typeof v === "string" && /^\d{8}$/.test(v)) {
      const d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)));
      return d.getTime();
    }
  }
  return null;
}

function pickNumber(r: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = r[k];
    if (v == null) continue;
    const n = Number(String(v).replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Latest balance + previous day, derived from the tail of the history series. */
function toQuote(series: SeriesPoint[]): CreditQuote | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  return { value: last.v, prevValue: prev ? prev.v : null };
}

/**
 * Collect the credit-balance snapshot: ~1 year of daily 신용거래융자 잔고 for KOSPI /
 * KOSDAQ plus the latest value per market. Tolerant — confirms the source via the
 * metadata API, then pulls the series; any failure surfaces as a thrown error that
 * the market collector records in `errors[]` (the card shows 데이터 없음).
 */
export async function fetchCreditSnapshot(timeoutMs = 20_000): Promise<CreditSnapshot> {
  const latest = await fetchLatestDate(timeoutMs);
  const to = latest ?? ymd(new Date());
  const from = ymd(new Date(Date.now() - 400 * 24 * 60 * 60_000));
  const { kospi, kosdaq } = await fetchCreditRows(from, to, timeoutMs);
  if (kospi.length === 0 && kosdaq.length === 0) {
    throw new Error("KOFIA 신용공여 잔고: 데이터 게이트웨이에서 행을 받지 못했습니다 (연결 미완)");
  }
  return { kospi: toQuote(kospi), kosdaq: toQuote(kosdaq), history: { kospi, kosdaq } };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
