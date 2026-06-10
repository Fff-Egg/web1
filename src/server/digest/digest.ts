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
- 각 글을 \`- 한 줄 요약 [N] (영향)\` 형식으로 한 줄씩. 제목·URL은 쓰지 말고 글 번호 [N]만 단다.

규칙: 제공된 정보에 없는 내용을 지어내지 말 것. 글 인용은 번호 [N]로만 하고(제목·링크 직접 작성 금지), 시스템이 각주로 출처·원문 링크를 붙인다.`;

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

/** Escape text for safe interpolation into raw HTML (digest renders via dangerouslySetInnerHTML). */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Permit only http(s) links in rendered HTML; anything else → no link. */
function safeUrl(u: string | null | undefined): string | null {
  const t = u?.trim();
  return t && /^https?:\/\//i.test(t) ? t : null;
}

/**
 * Parse the inside of a citation bracket into in-range article numbers.
 * Supports "3", grouped "3, 5" / "3,5", and ranges "3-5" / "3–5".
 * Out-of-range and non-numeric segments are dropped; order/dedup preserved.
 */
function parseRefNums(inner: string, max: number): number[] {
  const out: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= max && !out.includes(n)) out.push(n);
  };
  for (const seg of inner.split(",")) {
    const s = seg.trim();
    if (!s) continue;
    const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) add(n);
    } else if (/^\d+$/.test(s)) {
      add(Number(s));
    }
  }
  return out;
}

/**
 * Turn numeric citations into footnote-style superscript links to the matching
 * "참조 원문" entry (#ref-N). Handles single [3], grouped [3, 5] / [3,5], and
 * ranges [3-5]; (?!\() avoids real markdown links; out-of-range/non-numeric
 * brackets are left untouched. The first occurrence of each number gets an id
 * so its footnote can link back.
 */
function linkifyRefs(md: string, rows: DigestItem[]): string {
  const seen = new Set<number>();
  return md.replace(/\[([\d, –-]+)\](?!\()/g, (m, inner) => {
    const nums = parseRefNums(inner, rows.length);
    if (nums.length === 0) return m;
    return nums
      .map((n) => {
        const idAttr = seen.has(n) ? "" : ` id="cite-${n}"`;
        seen.add(n);
        return `<sup class="cite"${idAttr}><a href="#ref-${n}">[${n}]</a></sup>`;
      })
      .join("");
  });
}

/** Deterministic numbered "참조 원문" list — footnote targets carrying each pick's link. */
function sourceLinks(rows: DigestItem[]): string {
  const items = rows.map((it, i) => {
    const n = i + 1;
    const url = safeUrl(it.url);
    const title = escHtml(it.title ?? "(제목없음)");
    const titleHtml = url
      ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      : title;
    const back = `<a href="#cite-${n}" class="ref-back" title="본문으로">↩</a>`;
    return `  <li id="ref-${n}">${titleHtml} <span class="ref-src">— 출처: ${escHtml(it.source)}</span> ${back}</li>`;
  });
  return `\n<h2>참조 원문</h2>\n<ol class="digest-refs">\n${items.join("\n")}\n</ol>\n`;
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
      (cfg.digestInstructions?.trim() || DIGEST_SYSTEM) +
      "\n\n[인용·링크 규칙(필수)] 글을 언급·요약·추천(특히 '원문 정독 추천')할 때 제목 텍스트나 URL을 본문에 직접 쓰지 마라. " +
      "반드시 위 입력의 글 번호만 대괄호 숫자로 단다(예: [3]). 한 글을 여러 번 언급해도 같은 번호를 쓴다. " +
      "'나머지 한 줄 정리'·'기타' 같은 목록을 포함해 글을 가리키는 모든 항목에 번호를 빠짐없이 단다(누락 금지). " +
      "한 줄에서 여러 글을 묶을 때는 글마다 번호를 단다: [3][5] 또는 [3, 5] 형식(범위 [3-5]도 가능). " +
      "시스템이 이 번호를 윗첨자 각주로 바꿔 하단 '참조 원문' 목록(원문 링크 포함)으로 연결한다. " +
      "'[제목](링크)' 형태가 떠올라도 절대 쓰지 말고 번호만 남겨라.";
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
    // Turn [N] citations into footnote links, then append the numbered "참조 원문" list.
    markdown = `${linkifyRefs(report.trim(), rows)}\n${sourceLinks(rows)}`;
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
