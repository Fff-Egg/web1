/**
 * 한경 컨센서스 (consensus.hankyung.com) — daily broker research report list.
 *
 * The list page is server-rendered HTML with a results table whose columns are
 * 작성일 · 분류 · 제목 · 적정가격(TP) · 투자의견 · 작성자/제공출처(증권사) · 첨부(PDF).
 * We parse it with tolerant regex (the project has no DOM lib — see rss.ts) and map
 * cells by HEADER TEXT, so column reordering doesn't break extraction.
 *
 * ⚠ This sandbox blocks consensus.hankyung.com (egress allowlist), so the parser is
 * written against the site's known structure and runs live on Railway (outbound open).
 * If the markup differs, `parseTable` is the one place to adjust — the column-header
 * map + cell helpers below isolate every site-specific detail.
 */

const BASE = "https://consensus.hankyung.com";
const LIST = `${BASE}/analysis/list`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface ParsedReport {
  reportDate: string;
  category: string;
  title: string;
  stockName: string | null;
  stockCode: string | null;
  targetPrice: string | null;
  targetPriceNum: number | null;
  opinion: string | null;
  broker: string | null;
  pdfUrl: string | null;
  externalId: string;
}

/**
 * Fetch all reports with 작성일 in [sdate, edate] (YYYY-MM-DD), paging until a page
 * yields no new rows. Reports across all 분류 are returned (we categorize per row).
 */
export async function fetchReportsRange(sdate: string, edate: string, maxPages = 12): Promise<ParsedReport[]> {
  const out: ParsedReport[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${LIST}?sdate=${sdate}&edate=${edate}&report_type=&now_page=${page}&pagenum=40&search_text=`;
    const html = await fetchHtml(url);
    const rows = parseTable(html);
    if (rows.length === 0) break;
    let added = 0;
    for (const r of rows) {
      if (seen.has(r.externalId)) continue;
      seen.add(r.externalId);
      out.push(r);
      added++;
    }
    if (added === 0) break; // page repeated → past the last page
  }
  return out;
}

async function fetchHtml(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: `${BASE}/analysis/list`, "Accept-Language": "ko-KR,ko;q=0.9" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`한경 컨센서스 HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─── HTML table parsing (tolerant regex, header-mapped) ─────────────

type Col = "date" | "category" | "title" | "tp" | "opinion" | "broker" | "pdf";

function parseTable(html: string): ParsedReport[] {
  // The results table is the one whose markup mentions 작성일 + 제목.
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const table = tables.find((t) => /작성일/.test(t) && /제목/.test(t)) ?? tables[0];
  if (!table) return [];
  const rowHtml = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rowHtml.length === 0) return [];

  const headerRow = rowHtml.find((r) => /<th[\s>]/i.test(r)) ?? rowHtml[0] ?? "";
  const colMap = mapColumns(cellList(headerRow).map((c) => stripTags(c)));

  const out: ParsedReport[] = [];
  for (const row of rowHtml) {
    if (/<th[\s>]/i.test(row)) continue;
    const cells = cellList(row);
    if (cells.length < 3) continue;
    const cell = (k: Col): string => {
      const i = colMap[k];
      return i == null || i >= cells.length ? "" : cells[i];
    };

    const reportDate = normDate(stripTags(cell("date")));
    if (!reportDate) continue;
    const titleCell = cell("title");
    const title = stripTags(titleCell);
    if (!title) continue;

    const category = normCategory(stripTags(cell("category")));
    const pdfUrl = absUrl(firstHref(cell("pdf")) || firstHref(titleCell));
    const broker = stripTags(cell("broker")) || null;
    const tpRaw = stripTags(cell("tp"));
    const { stockName, stockCode } = parseStock(title, titleCell, category);
    const externalId =
      reportIdx(pdfUrl) ?? `${reportDate}|${broker ?? ""}|${title}`.slice(0, 190);

    out.push({
      reportDate,
      category,
      title,
      stockName,
      stockCode,
      targetPrice: blankToNull(tpRaw),
      targetPriceNum: parseNum(tpRaw),
      opinion: blankToNull(stripTags(cell("opinion"))),
      broker,
      pdfUrl,
      externalId,
    });
  }
  return out;
}

/** Map header texts → column indices by keyword. */
function mapColumns(headers: string[]): Partial<Record<Col, number>> {
  const m: Partial<Record<Col, number>> = {};
  headers.forEach((h, i) => {
    if (m.date == null && /작성일|일자|날짜/.test(h)) m.date = i;
    else if (m.category == null && /분류|구분/.test(h)) m.category = i;
    else if (m.title == null && /제목|리포트|타이틀/.test(h)) m.title = i;
    else if (m.tp == null && /적정|목표|가격/.test(h)) m.tp = i;
    else if (m.opinion == null && /의견|투자/.test(h)) m.opinion = i;
    else if (m.broker == null && /작성|제공|증권|출처|기관/.test(h)) m.broker = i;
    else if (m.pdf == null && /첨부|다운|파일|pdf/i.test(h)) m.pdf = i;
  });
  // Fallback to the common column order if headers were unrecognizable.
  if (m.date == null) m.date = 0;
  if (m.category == null) m.category = 1;
  if (m.title == null) m.title = 2;
  if (m.tp == null) m.tp = 3;
  if (m.opinion == null) m.opinion = 4;
  if (m.broker == null) m.broker = 5;
  return m;
}

/** Inner HTML of each <td>/<th> in a row. */
function cellList(rowHtml: string): string[] {
  return (rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((c) =>
    c.replace(/^<t[dh][^>]*>/i, "").replace(/<\/t[dh]>$/i, ""),
  );
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function firstHref(html: string): string | null {
  return html.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
}

function absUrl(href: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return BASE + (href.startsWith("/") ? href : "/" + href);
}

function reportIdx(url: string | null): string | null {
  const idx = url?.match(/report_idx=(\d+)/i)?.[1] ?? url?.match(/[?&]idx=(\d+)/i)?.[1];
  return idx ? `hk:${idx}` : null;
}

/** "26-06-20" | "2026-06-20" | "2026.06.20" | "06/20" → YYYY-MM-DD (or ""). */
function normDate(s: string): string {
  const m = s.match(/(\d{4}|\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) {
    const y = m[1].length === 2 ? `20${m[1]}` : m[1];
    return `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  const md = s.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
  if (md) {
    const now = new Date();
    return `${now.getFullYear()}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
  }
  return "";
}

const CATEGORY_ALIAS: Record<string, string> = {
  기업: "기업", 종목: "기업", 산업: "산업", 업종: "산업",
  시황: "시황", 시장: "시황", 경제: "경제", 채권: "채권", 파생: "파생",
};
function normCategory(raw: string): string {
  const key = raw.replace(/\s+/g, "");
  for (const [k, v] of Object.entries(CATEGORY_ALIAS)) if (key.includes(k)) return v;
  return key || "기타";
}

/** Empty or dash/dot-only placeholder → null. */
function blankToNull(s: string): string | null {
  return s && !/^[-–—·.\s]*$/.test(s) ? s : null;
}

/** "12,345" / "90,000원" → number(원); null for "-"/""/0. */
function parseNum(s: string): number | null {
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pull a stock name/code from the title (company reports). Codes are 6 digits if
 * present anywhere in the cell; the name is the leading token before a dash/paren.
 */
function parseStock(title: string, cell: string, category: string): { stockName: string | null; stockCode: string | null } {
  const code = (cell.match(/\b(\d{6})\b/) ?? title.match(/\b(\d{6})\b/))?.[1] ?? null;
  if (category !== "기업") return { stockName: null, stockCode: code };
  const name = title.split(/\s*[(\[]|\s+[-–—]\s+|[,:]/)[0].trim();
  return { stockName: name || null, stockCode: code };
}
