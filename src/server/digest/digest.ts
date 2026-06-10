import { and, or, gte, lt, eq, desc, isNull } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, articles, sources, digests } from "../db/schema.js";
import { settingsRepo } from "../repo/settings.js";
import { complete, hasLLM, ANALYSIS_MODEL } from "../analysis/anthropic.js";

/** Today's date (YYYY-MM-DD) in KST. */
export function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** [start, end) UTC instants bounding the KST days [startDate, endDate] inclusive. */
function kstRangeBounds(startDate: string, endDate: string): { start: Date; end: Date } {
  const start = new Date(`${startDate}T00:00:00+09:00`);
  // end is exclusive → midnight after the endDate
  const end = new Date(new Date(`${endDate}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const DIGEST_SYSTEM = `너는 내 개인 투자 다이제스트 편집자다. 아래는 오늘 분석된 글들의 목록이다.
이를 바탕으로 한국어 마크다운 일일 리포트를 작성한다. 구성:

## 오늘의 핵심 3가지
- 가장 중요한 3가지를 불릿으로.

## 종목·테마별 업데이트
- 종목/테마별로 묶어 정리하고 각 항목에 영향(상승/하락/중립)을 표시.

## 주목할 신규 글
- 각 글을 \`- [제목](원문링크) — 출처: 소스명 (영향)\` 형식으로. **반드시 원문 링크와 출처를 포함**한다.

규칙: 제공된 정보에 없는 내용을 지어내지 말 것. 모든 인용 글에는 출처와 원문 링크를 남길 것.`;

interface DigestItem {
  title: string | null;
  url: string | null;
  source: string;
  impact: string | null;
  summary: string | null;
  body: string | null;
  tickers: string[] | null;
  themes: string[] | null;
}

function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Deterministic "원문 모음" list so picked articles always carry their links. */
function sourceLinks(rows: DigestItem[]): string {
  const lines = ["", "## 원문 모음", ""];
  for (const it of rows) {
    const link = it.url ? `[${it.title ?? "(제목없음)"}](${it.url})` : it.title ?? "(제목없음)";
    lines.push(`- ${link} — 출처: ${it.source}`);
  }
  return lines.join("\n");
}

export interface GenerateDigestOpts {
  /** KST date YYYY-MM-DD (inclusive). Defaults to today. */
  start?: string;
  /** KST date YYYY-MM-DD (inclusive). Defaults to `start`. */
  end?: string;
  /** Display name. Defaults to the period string. */
  title?: string;
}

/**
 * Generate a saved digest over a KST date range. Gathers that period's relevant
 * (non-trashed) picks, synthesizes a markdown report (2차 지침) with source
 * links, and inserts a new `digests` row. Returns null if nothing to do.
 */
export async function generateDigest(
  opts: GenerateDigestOpts = {},
): Promise<{ id: number; title: string; itemCount: number } | null> {
  if (!hasDb) {
    console.warn("[digest] no DATABASE_URL — skipping.");
    return null;
  }
  const startDate = opts.start ?? kstToday();
  const endDate = opts.end ?? startDate;
  const title = opts.title?.trim() || (startDate === endDate ? `${startDate}` : `${startDate} ~ ${endDate}`);
  const { start, end } = kstRangeBounds(startDate, endDate);

  const rows: DigestItem[] = await db
    .select({
      title: articles.title,
      url: articles.url,
      source: sources.label,
      impact: analyses.impact,
      summary: analyses.summary,
      body: articles.body,
      tickers: analyses.tickers,
      themes: analyses.themes,
    })
    .from(analyses)
    .innerJoin(articles, eq(analyses.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(
      and(
        eq(analyses.relevant, true),
        isNull(articles.deletedAt),
        // period's important picks, plus saved "read later" items from any time
        or(
          and(
            eq(analyses.lowPriority, false),
            gte(analyses.createdAt, start),
            lt(analyses.createdAt, end),
          ),
          eq(analyses.saved, true),
        ),
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .then((r) =>
      r.map((x) => ({ ...x, source: x.source ?? "(출처 미상)" })),
    );

  if (rows.length === 0) {
    console.log(`[digest] ${title}: no relevant picks, skipping.`);
    return null;
  }

  let markdown: string;
  if (hasLLM()) {
    const cfg = await settingsRepo.getAnalysisConfig();
    // 2차 지침: how to synthesize the day's picks (user-editable in Settings).
    const system =
      "★ 모든 출력은 반드시 한국어로 작성한다. 중국어·일본어 절대 금지. (영어 고유명사·티커만 예외)\n\n" +
      (cfg.digestInstructions?.trim() || DIGEST_SYSTEM);
    const user =
      `기간: ${startDate} ~ ${endDate}\n\n1차로 선별된 글 (${rows.length}건). 본문을 읽고 종합하라:\n\n` +
      rows
        .map(
          (it, i) =>
            `[${i + 1}] 제목: ${it.title ?? "(제목없음)"}\n` +
            `출처: ${it.source}\n` +
            `원문: ${it.url ?? "(링크없음)"}\n` +
            `본문:\n${clip(it.body ?? it.summary, 1500)}`,
        )
        .join("\n\n---\n\n");
    const report = await complete({
      model: cfg.analysisModel || ANALYSIS_MODEL(),
      system,
      user,
      maxTokens: Number(process.env.DIGEST_MAX_TOKENS ?? 4096),
    });
    // Always append the picked articles with their original links.
    markdown = `${report.trim()}\n${sourceLinks(rows)}`;
  } else {
    // No API key — build a simple deterministic digest so attribution still works.
    markdown = buildFallbackMarkdown(title, rows);
  }

  const [res] = await db
    .insert(digests)
    .values({
      title,
      periodStart: startDate,
      periodEnd: endDate,
      markdown,
      meta: { itemCount: rows.length },
    })
    .$returningId();

  console.log(`[digest] "${title}": saved (${rows.length} items).`);
  return { id: Number(res.id), title, itemCount: rows.length };
}

function buildFallbackMarkdown(title: string, rows: DigestItem[]): string {
  const lines = [`# ${title}`, "", "## 주목할 신규 글", ""];
  for (const it of rows) {
    const link = it.url ? `[${it.title ?? "(제목없음)"}](${it.url})` : it.title ?? "(제목없음)";
    lines.push(`- ${link} — 출처: ${it.source} (${it.impact ?? "neutral"})`);
    if (it.summary) lines.push(`  - ${it.summary}`);
  }
  return lines.join("\n");
}
