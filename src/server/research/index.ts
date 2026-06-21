import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { researchReports, settings } from "../db/schema.js";
import type { ReportRow, ResearchList } from "../../shared/research.js";
import { COVERAGE_WORKDAYS, MAJOR_THRESHOLD } from "../../shared/research.js";
import { fetchReportsRange } from "./hankyung.js";

const META_KEY = "researchMeta";
/** Calendar days of history to fetch/keep — covers the 5-working-day window + TP context. */
const LOOKBACK_DAYS = 14;

interface ResearchMeta {
  collectedAt: string | null;
  error: string | null;
}

/**
 * Collect recent reports (last ~2 weeks) from 한경 컨센서스 and upsert them. The
 * range (not just today) keeps the coverage window + prior-TP context fresh and
 * self-heals gaps. Dedupe is by external_id (unique). Tolerant — failures are
 * recorded in the meta note, never thrown to the scheduler.
 */
export async function collectResearch(): Promise<{ inserted: number; error: string | null }> {
  if (!hasDb) return { inserted: 0, error: "DB 미설정 (DATABASE_URL)" };
  const today = new Date();
  const from = new Date(today.getTime() - LOOKBACK_DAYS * 86_400_000);

  let parsed;
  try {
    parsed = await fetchReportsRange(ymd(from), ymd(today));
  } catch (e) {
    const error = `한경 컨센서스 수집 실패: ${e instanceof Error ? e.message : String(e)}`;
    await setMeta({ collectedAt: (await getMeta()).collectedAt, error });
    return { inserted: 0, error };
  }

  let inserted = 0;
  for (const r of parsed) {
    try {
      await db
        .insert(researchReports)
        .values({
          reportDate: r.reportDate,
          category: r.category,
          title: r.title,
          stockName: r.stockName,
          stockCode: r.stockCode,
          targetPrice: r.targetPrice,
          targetPriceNum: r.targetPriceNum,
          opinion: r.opinion,
          broker: r.broker,
          pdfUrl: r.pdfUrl,
          source: "hankyung",
          externalId: r.externalId,
        })
        // Re-collected rows may gain a TP/opinion (intraday updates) — refresh those.
        .onDuplicateKeyUpdate({
          set: {
            title: r.title,
            category: r.category,
            targetPrice: r.targetPrice,
            targetPriceNum: r.targetPriceNum,
            opinion: r.opinion,
          },
        });
      inserted++;
    } catch {
      /* skip a malformed row */
    }
  }

  await setMeta({
    collectedAt: new Date().toISOString(),
    error: parsed.length === 0 ? "수집된 리포트가 없습니다 (페이지 구조 변경 가능)" : null,
  });
  return { inserted, error: null };
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
    .orderBy(desc(researchReports.reportDate))
    .limit(90);
  const dates = dateRows.map((r) => r.d);
  if (dates.length === 0) {
    return { date: null, dates: [], reports: [], collectedAt: meta.collectedAt, error: meta.error };
  }
  const date = dateInput && dates.includes(dateInput) ? dateInput : dates[0];

  // Load a window of rows (selected date back LOOKBACK_DAYS) for coverage + TP context.
  const fromDate = ymd(new Date(parseDate(date).getTime() - LOOKBACK_DAYS * 86_400_000));
  const rows = await db
    .select()
    .from(researchReports)
    .where(and(gte(researchReports.reportDate, fromDate), lte(researchReports.reportDate, date)));

  const keyOf = (r: { stockCode: string | null; stockName: string | null }): string =>
    (r.stockCode || r.stockName || "").trim();

  // 5-working-day window = the 5 most recent distinct report dates ≤ selected date.
  const windowDates = new Set(
    [...new Set(rows.map((r) => r.reportDate))].sort().reverse().slice(0, COVERAGE_WORKDAYS),
  );
  const coverage = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k && windowDates.has(r.reportDate)) coverage.set(k, (coverage.get(k) ?? 0) + 1);
  }

  const todays = rows.filter((r) => r.reportDate === date);
  const reports: ReportRow[] = todays.map((r) => {
    const k = keyOf(r);
    const coverageCount = k ? coverage.get(k) ?? 0 : 0;
    let tpRaised = false;
    if (r.targetPriceNum && k && r.broker) {
      const priors = rows
        .filter((p) => keyOf(p) === k && p.broker === r.broker && p.reportDate < date && p.targetPriceNum)
        .sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1));
      if (priors.length > 0 && r.targetPriceNum > (priors[0].targetPriceNum ?? 0)) tpRaised = true;
    }
    return {
      id: r.id,
      reportDate: r.reportDate,
      category: r.category,
      title: r.title,
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
