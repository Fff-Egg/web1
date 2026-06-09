import { and, gte, lt, eq, desc } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, articles, sources, digests } from "../db/schema.js";
import { settingsRepo } from "../repo/settings.js";
import { complete, hasLLM, ANALYSIS_MODEL } from "../analysis/anthropic.js";

/** Today's date (YYYY-MM-DD) in KST. */
export function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** [start, end) UTC instants bounding the given KST calendar day. */
function kstDayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
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
  tickers: string[] | null;
  themes: string[] | null;
}

/**
 * Generate (or regenerate) the daily digest for a KST date. Gathers that day's
 * relevant analyses, synthesizes a markdown report (with source attribution +
 * original links), and upserts it into `digests`. Returns null if nothing to do.
 */
export async function generateDigest(
  date: string = kstToday(),
): Promise<{ date: string; itemCount: number } | null> {
  if (!hasDb) {
    console.warn("[digest] no DATABASE_URL — skipping.");
    return null;
  }
  const { start, end } = kstDayBounds(date);

  const rows: DigestItem[] = await db
    .select({
      title: articles.title,
      url: articles.url,
      source: sources.label,
      impact: analyses.impact,
      summary: analyses.summary,
      tickers: analyses.tickers,
      themes: analyses.themes,
    })
    .from(analyses)
    .innerJoin(articles, eq(analyses.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(
      and(
        eq(analyses.relevant, true),
        gte(analyses.createdAt, start),
        lt(analyses.createdAt, end),
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .then((r) =>
      r.map((x) => ({ ...x, source: x.source ?? "(출처 미상)" })),
    );

  if (rows.length === 0) {
    console.log(`[digest] ${date}: no relevant analyses, skipping.`);
    return null;
  }

  let markdown: string;
  if (hasLLM()) {
    const cfg = await settingsRepo.getAnalysisConfig();
    const user =
      `날짜: ${date}\n\n분석된 글 (${rows.length}건):\n` +
      rows
        .map(
          (it, i) =>
            `${i + 1}. 제목: ${it.title ?? "(제목없음)"}\n` +
            `   출처: ${it.source}\n` +
            `   원문: ${it.url ?? "(링크없음)"}\n` +
            `   영향: ${it.impact ?? "neutral"}\n` +
            `   종목: ${(it.tickers ?? []).join(", ") || "-"}\n` +
            `   테마: ${(it.themes ?? []).join(", ") || "-"}\n` +
            `   요약: ${it.summary ?? "-"}`,
        )
        .join("\n\n");
    markdown = await complete({
      model: cfg.analysisModel || ANALYSIS_MODEL(),
      system: DIGEST_SYSTEM,
      user,
      maxTokens: 2048,
    });
  } else {
    // No API key — build a simple deterministic digest so attribution still works.
    markdown = buildFallbackMarkdown(date, rows);
  }

  await db
    .insert(digests)
    .values({ date, markdown, meta: { itemCount: rows.length } })
    .onDuplicateKeyUpdate({ set: { markdown, meta: { itemCount: rows.length } } });

  console.log(`[digest] ${date}: saved (${rows.length} items).`);
  return { date, itemCount: rows.length };
}

function buildFallbackMarkdown(date: string, rows: DigestItem[]): string {
  const lines = [`# 일일 다이제스트 — ${date}`, "", "## 주목할 신규 글", ""];
  for (const it of rows) {
    const link = it.url ? `[${it.title ?? "(제목없음)"}](${it.url})` : it.title ?? "(제목없음)";
    lines.push(`- ${link} — 출처: ${it.source} (${it.impact ?? "neutral"})`);
    if (it.summary) lines.push(`  - ${it.summary}`);
  }
  return lines.join("\n");
}
