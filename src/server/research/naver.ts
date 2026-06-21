/**
 * 네이버 증권 리포트 (finance.naver.com/research) — daily broker research lists.
 *
 * Naver aggregates a wide set of brokerages (via FnGuide), with more volume than
 * 한경 컨센서스. Each category has its own paginated, EUC-KR-encoded HTML list:
 *   종목분석 → 기업, 산업분석 → 산업, 시황정보 → 시황, 투자정보 → 투자,
 *   경제분석 → 경제, 채권분석 → 채권.
 * The list rows give 종목명(+코드)·제목·증권사·PDF·작성일 but NOT the target price.
 * For company reports, 목표주가·투자의견 live on the report's read page (structured
 * fields — no PDF parsing), fetched separately via `fetchDetail`.
 *
 * Parsing is tolerant regex (the project has no DOM lib — see rss.ts), header-mapped
 * so column shifts don't break it. ⚠ This sandbox blocks finance.naver.com (egress);
 * the parser targets Naver's known markup and runs live on Railway (outbound open).
 */

const BASE = "https://finance.naver.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

interface ListDef {
  path: string;
  category: string;
  /** Whether the list has a 종목명 column (company reports). */
  stock: boolean;
}
const LISTS: ListDef[] = [
  { path: "/research/company_list.naver", category: "기업", stock: true },
  { path: "/research/industry_list.naver", category: "산업", stock: false },
  { path: "/research/market_info_list.naver", category: "시황", stock: false },
  { path: "/research/invest_list.naver", category: "투자", stock: false },
  { path: "/research/economy_list.naver", category: "경제", stock: false },
  { path: "/research/debenture_list.naver", category: "채권", stock: false },
];

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
  /** Read-page URL — used to enrich company reports with TP/opinion (not stored). */
  detailUrl?: string;
  /** Filled by the collector after enrichment. */
  summary?: string | null;
  marketCap?: number | null;
}

/**
 * Fetch list rows (no TP yet) across all categories with 작성일 in [fromDate, toDate]
 * (YYYY-MM-DD). Pages newest-first per category, stopping once a page falls before
 * the window. TP/opinion are filled later by `fetchDetail` (company reports only).
 */
export async function fetchListRange(fromDate: string, toDate: string, maxPagesPerCat = 20): Promise<ParsedReport[]> {
  const out: ParsedReport[] = [];
  for (const def of LISTS) {
    for (let page = 1; page <= maxPagesPerCat; page++) {
      const html = await fetchHtml(`${BASE}${def.path}?&page=${page}`);
      const rows = parseListPage(html, def);
      if (rows.length === 0) break;
      let oldestBeforeWindow = false;
      for (const r of rows) {
        if (r.reportDate < fromDate) {
          oldestBeforeWindow = true;
          continue;
        }
        if (r.reportDate > toDate) continue;
        out.push(r);
      }
      if (oldestBeforeWindow) break; // reached older than the window
    }
  }
  return out;
}

/** Fetch a report's read page and extract 목표주가(TP) + 투자의견 + body text (for 요약). */
export async function fetchDetail(
  url: string,
): Promise<{ targetPrice: string | null; targetPriceNum: number | null; opinion: string | null; bodyText: string }> {
  const html = await fetchHtml(url);
  // The read page shows 목표주가 / 투자의견 as labelled fields near the top.
  const tpRaw = html.match(/목표주가[\s\S]{0,120}?([\d][\d,]{2,})\s*원?/)?.[1] ?? null;
  const opinion =
    html
      .match(/투자의견[\s\S]{0,120}?(적극매수|매수|매도|중립|보유|비중확대|비중축소|Strong\s*Buy|Trading\s*Buy|Outperform|Marketperform|Buy|Hold|Sell|Neutral)/i)?.[1]
      ?.trim() ?? null;
  return {
    targetPrice: tpRaw ? stripTags(tpRaw) : null,
    targetPriceNum: parseNum(tpRaw ?? ""),
    opinion,
    bodyText: bodyTextOf(html),
  };
}

/**
 * Current 시가총액 for a stock (원), from the Naver 종목 main page (#_market_sum,
 * e.g. "513조 4,567" 억원). Same host (finance.naver.com) as the report pages.
 */
export async function fetchMarketCap(code: string): Promise<number | null> {
  const html = await fetchHtml(`${BASE}/item/main.naver?code=${code}`);
  const raw = html.match(/id=["']_market_sum["'][^>]*>([\s\S]*?)<\/em>/i)?.[1];
  return raw ? parseMarketCap(stripTags(raw)) : null;
}

/** "513조 4,567" / "8,234" (억원) → number(원). */
function parseMarketCap(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, "");
  const jo = t.match(/(\d+)조/);
  if (jo) {
    const eok = t.match(/조(\d+)/)?.[1];
    return Number(jo[1]) * 1e12 + (eok ? Number(eok) * 1e8 : 0);
  }
  const eok = (t.match(/(\d+)억/) ?? t.match(/(\d+)/))?.[1];
  return eok ? Number(eok) * 1e8 : null;
}

/** Visible text of a page body (scripts/styles dropped), capped for LLM input. */
function bodyTextOf(html: string): string {
  const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
  return stripTags(body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, 2500);
}

// ─── list page parsing ──────────────────────────────────────────────

function parseListPage(html: string, def: ListDef): ParsedReport[] {
  // The results table mentions 제목 + 작성일 (and 종목명 for company lists).
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const table = tables.find((t) => /작성일/.test(t) && /제목/.test(t)) ?? tables.find((t) => /제목/.test(t));
  if (!table) return [];
  const rowHtml = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rowHtml.length === 0) return [];

  const headerRow = rowHtml.find((r) => /<th[\s>]/i.test(r)) ?? rowHtml[0] ?? "";
  const cols = mapColumns(cellList(headerRow).map((c) => stripTags(c)), def.stock);

  const out: ParsedReport[] = [];
  for (const row of rowHtml) {
    if (/<th[\s>]/i.test(row)) continue;
    const cells = cellList(row);
    if (cells.length < 3) continue;
    const cell = (k: Col): string => {
      const i = cols[k];
      return i == null || i >= cells.length ? "" : cells[i];
    };

    const reportDate = normDate(stripTags(cell("date")));
    if (!reportDate) continue;
    const titleCell = cell("title");
    const title = stripTags(titleCell);
    if (!title) continue;

    const detailUrl = absUrl(firstHref(titleCell));
    const nid = detailUrl?.match(/nid=(\d+)/)?.[1];
    const externalId = nid ? `nv:${nid}` : `nv:${reportDate}|${title}`.slice(0, 190);

    const stockCell = cell("stock");
    const stockCode = def.stock ? firstHref(stockCell)?.match(/code=(\d{6})/)?.[1] ?? null : null;
    const stockName = def.stock ? blankToNull(stripTags(stockCell)) : null;

    out.push({
      reportDate,
      category: def.category,
      title,
      stockName,
      stockCode,
      targetPrice: null,
      targetPriceNum: null,
      opinion: null,
      broker: blankToNull(stripTags(cell("broker"))),
      pdfUrl: absUrl(firstHref(cell("pdf"))),
      externalId,
      detailUrl: detailUrl ?? undefined,
    });
  }
  return out;
}

type Col = "stock" | "title" | "broker" | "pdf" | "date";

function mapColumns(headers: string[], stock: boolean): Partial<Record<Col, number>> {
  const m: Partial<Record<Col, number>> = {};
  headers.forEach((h, i) => {
    if (m.stock == null && /종목/.test(h)) m.stock = i;
    else if (m.title == null && /제목|리포트/.test(h)) m.title = i;
    else if (m.broker == null && /증권|작성|제공|기관/.test(h)) m.broker = i;
    else if (m.pdf == null && /첨부|다운|파일|pdf/i.test(h)) m.pdf = i;
    else if (m.date == null && /작성일|일자|날짜|등록/.test(h)) m.date = i;
  });
  // Fallback to Naver's usual order if headers were unrecognizable.
  if (stock) {
    if (m.stock == null) m.stock = 0;
    if (m.title == null) m.title = 1;
    if (m.broker == null) m.broker = 2;
    if (m.pdf == null) m.pdf = 3;
    if (m.date == null) m.date = 4;
  } else {
    if (m.title == null) m.title = 0;
    if (m.broker == null) m.broker = 1;
    if (m.pdf == null) m.pdf = 2;
    if (m.date == null) m.date = 3;
  }
  return m;
}

// ─── fetch (EUC-KR aware) + small HTML helpers ──────────────────────

async function fetchHtml(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: `${BASE}/research/`, "Accept-Language": "ko-KR,ko;q=0.9" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`네이버 증권 HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // Naver finance pages are EUC-KR; honor the header/meta charset, default utf-8.
    const ct = res.headers.get("content-type") ?? "";
    let charset = ct.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase();
    if (!charset) {
      const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
      charset = head.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
    }
    if (charset === "ms949" || charset === "cp949") charset = "euc-kr";
    try {
      return new TextDecoder(charset || "utf-8").decode(buf);
    } catch {
      return new TextDecoder("euc-kr").decode(buf);
    }
  } finally {
    clearTimeout(t);
  }
}

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
  return BASE + (href.startsWith("/") ? href : "/research/" + href);
}

function blankToNull(s: string): string | null {
  return s && !/^[-–—·.\s]*$/.test(s) ? s : null;
}

/** "26.06.20" | "2026.06.20" | "2026-06-20" → YYYY-MM-DD (or ""). */
function normDate(s: string): string {
  const m = s.match(/(\d{4}|\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return "";
  const y = m[1].length === 2 ? `20${m[1]}` : m[1];
  return `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** "120,000" / "90,000원" → number(원); null for ""/0. */
function parseNum(s: string): number | null {
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}
