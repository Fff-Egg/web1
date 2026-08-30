import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { researchReports, settings } from "../db/schema.js";
import type { ReportRow, ResearchList } from "../../shared/research.js";
import { COVERAGE_WORKDAYS, MAJOR_THRESHOLD } from "../../shared/research.js";
import { fetchListRange, fetchDetail, fetchMarketCap } from "./naver.js";
import { fetchHankyung } from "./hankyung.js";
import { ALLOWED_CATEGORIES, type ParsedReport } from "./types.js";
import { complete, hasLLM, FILTER_MODEL } from "../analysis/anthropic.js";

const ALLOWED = [...ALLOWED_CATEGORIES];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const META_KEY = "researchMeta";
/** Calendar days of history to fetch/keep — covers the 5-working-day window + TP context. */
const LOOKBACK_DAYS = 10;
/** Cap on read-page (TP/opinion/summary) fetches per run, so a backfill doesn't hammer Naver. */
const MAX_DETAIL = 160;
/** Cap on 시총 fetches per run. */
const MAX_MARKETCAP = 250;

/** 주요 내용 — condense a report's read-page text to one line via the LLM (DeepSeek). */
async function summarize(title: string, body: string): Promise<string | null> {
  if (!hasLLM() || body.trim().length < 40) return null;
  try {
    const out = await complete({
      model: FILTER_MODEL(),
      system:
        "너는 증권사 리포트를 핵심만 요약하는 한국어 어시스턴트다. 광고·메뉴·네비게이션·면책문구는 무시하고, " +
        "리포트의 핵심 논지/근거/실적·전망을 1문장(최대 90자)으로 압축한다. 숫자·종목명은 보존하고 군더더기 없이 평서문으로 쓴다.",
      user: `제목: ${title}\n\n페이지 내용:\n${body}`,
      maxTokens: 200,
      thinking: "disabled",
    });
    const s = out.replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 200) : null;
  } catch {
    return null;
  }
}

interface ResearchMeta {
  collectedAt: string | null;
  error: string | null;
}

/**
 * Collect recent reports (last ~10 days) from 네이버 증권 and upsert them. The range
 * (not just today) keeps the coverage window + prior-TP context fresh and self-heals
 * gaps. Company reports are enriched with 목표주가/투자의견 from their read pages, but
 * only the ones not already enriched in the DB (so detail fetches stay bounded to new
 * reports). Tolerant — failures are recorded in the meta note, never thrown.
 */
export async function collectResearch(): Promise<{ inserted: number; error: string | null }> {
  if (!hasDb) return { inserted: 0, error: "DB 미설정 (DATABASE_URL)" };
  const fromStr = ymd(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000));
  const toStr = ymd(new Date());

  // 네이버 + 한경 둘 다에서 수집, 기업·산업만.
  let naverRows: ParsedReport[] = [];
  let hkRows: ParsedReport[] = [];
  const errs: string[] = [];
  try {
    naverRows = await fetchListRange(fromStr, toStr);
  } catch (e) {
    errs.push(`네이버: ${msg(e)}`);
  }
  try {
    hkRows = await fetchHankyung(fromStr, toStr);
  } catch (e) {
    errs.push(`한경: ${msg(e)}`);
  }
  const rows = [...naverRows, ...hkRows].filter((r) => ALLOWED_CATEGORIES.has(r.category));
  if (rows.length === 0) {
    const error = errs.length
      ? `리포트 수집 실패 — ${errs.join(" / ")}`
      : "수집된 리포트가 없습니다 (페이지 구조 변경 가능)";
    await setMeta({ collectedAt: (await getMeta()).collectedAt, error });
    return { inserted: 0, error };
  }

  // 한경 행에 종목코드가 없으면 네이버의 (종목명→코드)로 채워 출처 간 종목 키를 통일.
  const nameToCode = new Map<string, string>();
  for (const r of rows) if (r.stockName && r.stockCode) nameToCode.set(r.stockName, r.stockCode);
  for (const r of rows) if (!r.stockCode && r.stockName && nameToCode.has(r.stockName)) r.stockCode = nameToCode.get(r.stockName) ?? null;

  // 네이버 종목 리포트만 read 페이지로 TP/의견/요약 보강(한경은 목록에 TP/의견이 있음).
  const enrichedRows = await db
    .select({ e: researchReports.externalId })
    .from(researchReports)
    .where(and(gte(researchReports.reportDate, fromStr), isNotNull(researchReports.targetPriceNum)));
  const enriched = new Set(enrichedRows.map((r) => r.e));
  const toEnrich = rows
    .filter((r) => r.source === "naver" && r.category === "기업" && r.detailUrl && !enriched.has(r.externalId))
    .slice(0, MAX_DETAIL);
  await mapLimit(toEnrich, 4, async (r) => {
    try {
      const d = await fetchDetail(r.detailUrl!);
      r.targetPrice = d.targetPrice;
      r.targetPriceNum = d.targetPriceNum;
      r.opinion = d.opinion;
      r.summary = await summarize(r.title, d.bodyText); // 주요 내용 (LLM 한 줄)
    } catch {
      /* leave fields empty for this report */
    }
  });

  // 현재 시총 — 최근(2일) 리포트의 종목만, capped + concurrency-limited (Naver 종목 페이지).
  const capFrom = ymd(new Date(Date.now() - 2 * 86_400_000));
  const codes = [
    ...new Set(rows.filter((r) => r.stockCode && r.reportDate >= capFrom).map((r) => r.stockCode!)),
  ].slice(0, MAX_MARKETCAP);
  const capMap = new Map<string, number>();
  await mapLimit(codes, 4, async (code) => {
    try {
      const mc = await fetchMarketCap(code);
      if (mc) capMap.set(code, mc);
    } catch {
      /* skip a stock */
    }
  });
  for (const r of rows) if (r.stockCode && capMap.has(r.stockCode)) r.marketCap = capMap.get(r.stockCode) ?? null;

  let inserted = 0;
  for (const r of rows) {
    try {
      await db
        .insert(researchReports)
        .values({
          reportDate: r.reportDate,
          category: r.category,
          title: r.title,
          summary: r.summary ?? null,
          marketCap: r.marketCap ?? null,
          stockName: r.stockName,
          stockCode: r.stockCode,
          targetPrice: r.targetPrice,
          targetPriceNum: r.targetPriceNum,
          opinion: r.opinion,
          broker: r.broker,
          pdfUrl: r.pdfUrl,
          source: r.source,
          externalId: r.externalId,
        })
        // Only overwrite TP/opinion/code when we have a fresh non-null value, so a
        // re-collection that skipped enrichment doesn't wipe an earlier read-page result.
        .onDuplicateKeyUpdate({
          set: {
            title: r.title,
            category: r.category,
            ...(r.targetPriceNum != null ? { targetPrice: r.targetPrice, targetPriceNum: r.targetPriceNum } : {}),
            ...(r.opinion != null ? { opinion: r.opinion } : {}),
            ...(r.stockCode != null ? { stockCode: r.stockCode } : {}),
            ...(r.summary != null ? { summary: r.summary } : {}),
            ...(r.marketCap != null ? { marketCap: r.marketCap } : {}),
          },
        });
      inserted++;
    } catch {
      /* skip a malformed row */
    }
  }

  await setMeta({
    collectedAt: new Date().toISOString(),
    error: errs.length ? `일부 출처 실패 — ${errs.join(" / ")}` : null,
  });
  return { inserted, error: errs.length ? errs.join(" / ") : null };
}

/** Run an async fn over items with bounded concurrency. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Build the board for one 작성일 (default = latest collected). Coverage count and
 * TP-상향 are derived here (system aggregation, not the LLM):
 *  - coverageCount: reports for the stock within the last 5 *working days* present
 *    in the data (the 5 most recent distinct report dates ≤ the selected date).
 *  - tpRaised: the same 증권사 raised its target price for the stock vs its most
 *    recent prior report.
 */
export async function listResearch(dateInput?: string): Promise<ResearchList> {
  const meta = await getMeta();
  if (!hasDb) return { date: null, dates: [], reports: [], collectedAt: meta.collectedAt, error: meta.error };

  const dateRows = await db
    .selectDistinct({ d: researchReports.reportDate })
    .from(researchReports)
    .where(inArray(researchReports.category, ALLOWED))
    .orderBy(desc(researchReports.reportDate))
    .limit(90);
  const dates = dateRows.map((r) => r.d);
  if (dates.length === 0) {
    return { date: null, dates: [], reports: [], collectedAt: meta.collectedAt, error: meta.error };
  }
  const date = dateInput && dates.includes(dateInput) ? dateInput : dates[0];

  // Load a window of rows (selected date back LOOKBACK_DAYS) for coverage + TP context.
  const fromDate = ymd(new Date(parseDate(date).getTime() - LOOKBACK_DAYS * 86_400_000));
  const rows = (
    await db
      .select()
      .from(researchReports)
      .where(and(gte(researchReports.reportDate, fromDate), lte(researchReports.reportDate, date)))
  ).filter((r) => ALLOWED_CATEGORIES.has(r.category));

  const keyOf = (r: { stockCode: string | null; stockName: string | null }): string =>
    (r.stockCode || r.stockName || "").trim();

  // 5-working-day window = the 5 most recent distinct report dates ≤ selected date.
  const windowDates = new Set(
    [...new Set(rows.map((r) => r.reportDate))].sort().reverse().slice(0, COVERAGE_WORKDAYS),
  );
  // Count distinct (증권사 + 작성일) per stock so the same report from two sources
  // (네이버 + 한경) isn't double-counted.
  const coverage = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k || !windowDates.has(r.reportDate)) continue;
    let set = coverage.get(k);
    if (!set) coverage.set(k, (set = new Set()));
    set.add(`${r.broker ?? ""}|${r.reportDate}`);
  }

  const todays = rows.filter((r) => r.reportDate === date);
  const reports: ReportRow[] = todays.map((r) => {
    const k = keyOf(r);
    const coverageCount = k ? coverage.get(k)?.size ?? 0 : 0;
    let tpRaised = false;
    if (r.targetPriceNum && k && r.broker) {
      const priors = rows
        .filter((p) => keyOf(p) === k && p.broker === r.broker && p.reportDate < date && p.targetPriceNum)
        .sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1));
      if (priors.length > 0 && r.targetPriceNum > (priors[0].targetPriceNum ?? 0)) tpRaised = true;
    }
    return {
      id: r.id,
      source: r.source,
      reportDate: r.reportDate,
      category: r.category,
      title: r.title,
      summary: r.summary,
      marketCap: r.marketCap,
      stockName: r.stockName,
      stockCode: r.stockCode,
      targetPrice: r.targetPrice,
      opinion: r.opinion,
      broker: r.broker,
      pdfUrl: r.pdfUrl,
      coverageCount,
      isMajor: coverageCount >= MAJOR_THRESHOLD,
      tpRaised,
    };
  });

  // Tier-up to the top: TP상향 → 주요 → higher coverage → name.
  reports.sort(
    (a, b) =>
      Number(b.tpRaised) - Number(a.tpRaised) ||
      Number(b.isMajor) - Number(a.isMajor) ||
      b.coverageCount - a.coverageCount ||
      a.category.localeCompare(b.category) ||
      (a.stockName ?? a.title).localeCompare(b.stockName ?? b.title),
  );

  return { date, dates, reports, collectedAt: meta.collectedAt, error: meta.error };
}

/** Collect then return the fresh board (the "지금 수집" button). */
export async function refreshResearch(date?: string): Promise<ResearchList> {
  await collectResearch();
  return listResearch(date);
}

/** When the last collection finished (ISO), for the scheduler's boot staleness check. */
export async function researchLastCollectedAt(): Promise<string | null> {
  return (await getMeta()).collectedAt;
}

// ─── meta (last collection time / error) under settings KV ──────────

async function getMeta(): Promise<ResearchMeta> {
  if (!hasDb) return { collectedAt: null, error: null };
  const rows = await db.select().from(settings).where(eq(settings.key, META_KEY)).limit(1);
  return (rows[0]?.value as unknown as ResearchMeta) ?? { collectedAt: null, error: null };
}

async function setMeta(m: ResearchMeta): Promise<void> {
  if (!hasDb) return;
  const value = m as unknown as Record<string, unknown>;
  await db.insert(settings).values({ key: META_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}
