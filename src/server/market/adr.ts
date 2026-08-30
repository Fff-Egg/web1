import type { AdrQuote, SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";

/**
 * Korean ADR (advance-decline ratio) for KOSPI / KOSDAQ, scraped from
 * adrinfo.kr. The page embeds the intraday series and the previous close as
 * inline JS constants, which are far more robust to parse than the rendered
 * markup:
 *
 *   const data_kospi_daily=[{"time":"09:05","adr":"74.97"},...,{"time":"15:30","adr":"72.99"}];
 *   const kospi_daily_last_adr=72.56;   // previous trading day's close
 *
 * The current ADR is the last point of the intraday array; `*_last_adr` is the
 * prior session's close (drawn as the dashed reference line on the chart).
 */
const URL = "http://adrinfo.kr/";

interface AdrResult {
  kospi: AdrQuote | null;
  kosdaq: AdrQuote | null;
}

/** Last `adr` value of a `const <name>=[...]` intraday array, or null. */
function lastOfSeries(html: string, name: string): number | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*(\\[.*?\\]);`).exec(html);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]) as { adr?: string }[];
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = Number(arr[i]?.adr);
      if (Number.isFinite(v)) return v;
    }
  } catch {
    /* malformed array */
  }
  return null;
}

/** A scalar `const <name>=<number>;`, or null. */
function scalar(html: string, name: string): number | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([\\d.]+)\\s*;`).exec(html);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function quote(html: string, series: string, prev: string): AdrQuote | null {
  const value = lastOfSeries(html, series);
  if (value === null) return null;
  return { value, prevClose: scalar(html, prev) };
}

export async function fetchAdr(timeoutMs = 20_000): Promise<AdrResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`adrinfo.kr HTTP ${res.status}`);
    const html = await res.text();
    const kospi = quote(html, "data_kospi_daily", "kospi_daily_last_adr");
    const kosdaq = quote(html, "data_kosdaq_daily", "kosdaq_daily_last_adr");
    if (!kospi && !kosdaq) throw new Error("adrinfo.kr: ADR 값을 찾지 못했습니다 (페이지 구조 변경?)");
    return { kospi, kosdaq };
  } finally {
    clearTimeout(t);
  }
}

const CHART_URL = "http://adrinfo.kr/chart_indx";

export interface AdrHistory {
  kospi: SeriesPoint[];
  kosdaq: SeriesPoint[];
}

/**
 * Extract the `<MARKET>:{adr:[[ts,val],...]}` array from the /chart_indx page's
 * inline `const dataSet={...}` blob via balanced-bracket scanning (the blob has
 * many series, so a greedy regex is unsafe).
 */
function extractAdrSeries(html: string, market: "KOSPI" | "KOSDAQ"): SeriesPoint[] {
  const anchor = html.indexOf(`${market}:{adr:[`);
  if (anchor < 0) return [];
  const arrStart = html.indexOf("[", anchor + market.length + 5);
  if (arrStart < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = arrStart; i < html.length; i++) {
    const c = html[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  try {
    // The array has a trailing comma (`..., ]`) and future-date placeholders
    // (`[ts, null]`); strip the trailing comma so JSON.parse accepts it, and the
    // null values are dropped by the numeric filter below.
    const cleaned = html.slice(arrStart, end + 1).replace(/,\s*]/g, "]");
    const arr = JSON.parse(cleaned) as [number, number][];
    return sliceLastYear(
      arr
        .filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number")
        .map((p) => ({ t: p[0], v: p[1] })),
    );
  } catch {
    return [];
  }
}

export async function fetchAdrHistory(timeoutMs = 20_000): Promise<AdrHistory> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CHART_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`adrinfo.kr/chart_indx HTTP ${res.status}`);
    const html = await res.text();
    return { kospi: extractAdrSeries(html, "KOSPI"), kosdaq: extractAdrSeries(html, "KOSDAQ") };
  } finally {
    clearTimeout(t);
  }
}
