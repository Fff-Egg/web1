import { and, or, gte, lt, lte, ne, eq, desc, isNull, inArray } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { analyses, articles, sources, digests } from "../db/schema.js";
import type { AnalysisConfig } from "../db/schema.js";
import { settingsRepo } from "../repo/settings.js";
import { complete, hasLLM, ANALYSIS_MODEL } from "../analysis/anthropic.js";

/** Today's date (YYYY-MM-DD) in KST. */
export function kstToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** Current hour (0–23) in KST. */
export function kstHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
}

/** Digest day boundary hour (KST). A "date" D = the window [(D-1) HH:00, D HH:00). */
const DIGEST_HOUR = (): number => Number(process.env.DIGEST_HOUR ?? 21);

/** Exported for the manual-run guards (buttons refuse to run before their hour). */
export const digestHour = DIGEST_HOUR;

/**
 * Start of the day-window that currently contains "now" (the 21시→21시 window).
 * Telegram uses this as its Feed↔보관함 boundary: items show in the Feed while
 * their createdAt is ≥ this edge, then at 21시 the edge shifts forward and the
 * day's telegram drops out of the Feed into 보관함 — no mutation, just the moving
 * boundary (keeps telegram alive for digest `?article` links).
 */
export function currentWindowStart(): Date {
  const h = DIGEST_HOUR();
  const boundary = new Date(`${kstToday()}T${String(h).padStart(2, "0")}:00:00+09:00`);
  // Before today's 21시 we're still in yesterday-21시→today-21시; after, the next window.
  return Date.now() < boundary.getTime()
    ? new Date(boundary.getTime() - 24 * 60 * 60 * 1000)
    : boundary;
}

/** Midday digest hour (KST) — the second daily run. Must sit inside the day
 *  window, i.e. strictly between 0 and DIGEST_HOUR; falls back to 14. */
export function middayHour(): number {
  const h = Number(process.env.DIGEST_MIDDAY_HOUR ?? 14);
  return Number.isFinite(h) && h > 0 && h < DIGEST_HOUR() ? h : 14;
}

/**
 * [start, end) UTC instants for the KST date range [startDate, endDate].
 * Days run on the DIGEST_HOUR (default 21:00) boundary, so date D covers
 * [(D-1) 21:00, D 21:00) KST → e.g. "11일" = 10일 21시 ~ 11일 21시.
 */
export function kstRangeBounds(startDate: string, endDate: string): { start: Date; end: Date } {
  const h = String(DIGEST_HOUR()).padStart(2, "0");
  const start = new Date(new Date(`${startDate}T${h}:00:00+09:00`).getTime() - 24 * 60 * 60 * 1000);
  const end = new Date(`${endDate}T${h}:00:00+09:00`);
  return { start, end };
}

/** The two daily auto-digest runs. They split date D's window at middayHour:
 *  midday = [(D-1) 21시, D 14시), evening = [D 14시, D 21시) — no gap, no overlap. */
export type DigestSlot = "midday" | "evening";

export function slotBounds(date: string, slot: DigestSlot): { start: Date; end: Date } {
  const day = kstRangeBounds(date, date);
  const mid = new Date(`${date}T${String(middayHour()).padStart(2, "0")}:00:00+09:00`);
  return slot === "midday" ? { start: day.start, end: mid } : { start: mid, end: day.end };
}

/** True if an auto digest already exists for this KST date — optionally for one
 *  slot. Legacy auto digests (pre-slot) count as the 21시 (evening) run. */
export async function hasAutoDigestFor(date: string, slot?: DigestSlot): Promise<boolean> {
  if (!hasDb) return false;
  const rows = await db
    .select({ meta: digests.meta })
    .from(digests)
    .where(and(eq(digests.periodStart, date), eq(digests.periodEnd, date), isNull(digests.deletedAt)));
  return rows.some((r) => {
    const m = r.meta as { auto?: boolean; slot?: string } | null | undefined;
    if (m?.auto !== true) return false;
    return !slot || (m.slot ?? "evening") === slot;
  });
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
  id: number;
  title: string | null;
  url: string | null;
  source: string;
  provider: string;
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
        const it = rows[n - 1];
        const tip = escHtml(`${it.title ?? "(제목없음)"} — 출처: ${it.source}`);
        const idAttr = seen.has(n) ? "" : ` id="cite-${n}"`;
        seen.add(n);
        return `<sup class="cite"${idAttr} data-tip="${tip}"><a href="#ref-${n}">[${n}]</a></sup>`;
      })
      .join("");
  });
}

/** Deterministic numbered "참조 원문" list — footnote targets carrying each pick's link. */
function sourceLinks(rows: DigestItem[]): string {
  const items = rows.map((it, i) => {
    const n = i + 1;
    const title = escHtml(it.title ?? "(제목없음)");
    const src = escHtml(it.source);
    let main: string;
    if (it.provider === "telegram") {
      // Telegram has no viewable original (private channels) or a members-only
      // t.me link, so link to the Feed (new tab) deep-linked to this article,
      // where the collected message body is stored and readable.
      main =
        `<a href="?article=${it.id}" class="ref-feed" target="_blank" rel="noopener">${title}</a>` +
        ` <span class="ref-src">— 출처: ${src} · 피드에서 원문 보기 ↗</span>`;
    } else {
      const url = safeUrl(it.url);
      const titleHtml = url
        ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
        : title;
      main = `${titleHtml} <span class="ref-src">— 출처: ${src}</span>`;
    }
    const back = `<a href="#cite-${n}" class="ref-back" title="본문으로">↩</a>`;
    return `  <li id="ref-${n}">${main} ${back}</li>`;
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
  /** Mark as a system-generated (cron) digest. */
  auto?: boolean;
  /** Auto-run slot: cover only that part of the day window (14시분/21시분). */
  slot?: DigestSlot;
  /** Synthesize from saved digests in range instead of the feed (past dates). */
  fromDigests?: boolean;
  /** After generating, sweep this window's (non-saved) feed picks to trash. */
  trashFeedAfter?: boolean;
}

const DIGEST_MAX_TOKENS = (): number => Number(process.env.DIGEST_MAX_TOKENS ?? 8192);

// ── Map-reduce synthesis (large windows) ────────────────────────────
// Above DIGEST_MAP_ITEMS picks, the window is split into size-balanced chunks
// (each ≤ ITEMS and ≤ CHARS of content) that are partial-summarized in parallel,
// then one final call synthesizes the digest from those summaries. Keeps every
// call small: no context overflow, no "lost in the middle" skipping.
const MAP_MAX_ITEMS = (): number => Math.max(5, Number(process.env.DIGEST_MAP_ITEMS ?? 30));
const MAP_MAX_CHARS = (): number => Math.max(10_000, Number(process.env.DIGEST_MAP_CHARS ?? 45_000));
const MAP_MAX_TOKENS = (): number => Number(process.env.DIGEST_MAP_TOKENS ?? 3000);
const MAP_CONCURRENCY = 3;
const ITEM_BODY_CHARS = 1500;

/** Content size of one item as packed into a map prompt. */
function itemSize(it: Pick<DigestItem, "title" | "body" | "summary">): number {
  const body = it.body ?? it.summary ?? "";
  return (it.title?.length ?? 0) + Math.min(body.length, ITEM_BODY_CHARS) + 60; // + envelope
}

/** One item as presented to the LLM — [N] is the GLOBAL citation number. */
function renderItem(it: DigestItem, n: number): string {
  return (
    `[${n}] 제목: ${it.title ?? "(제목없음)"}\n` +
    `출처: ${it.source}\n` +
    `원문: ${it.url ?? "(링크없음)"}\n` +
    `본문:\n${clip(it.body ?? it.summary, ITEM_BODY_CHARS)}`
  );
}

/**
 * Split row indices into balanced chunks for the map stage. Greedy LPT: walk
 * items largest-first, placing each into the lightest chunk that still has room
 * (≤ MAX_ITEMS and ≤ MAX_CHARS) — so long reads and one-liners mix instead of
 * count-only slicing putting 30 long articles in one chunk and 30 tweets in
 * another. Chunk count starts at the minimum the caps allow, growing only if
 * packing fails. Indices inside a chunk stay in feed order for readability.
 */
export function packChunks(rows: Pick<DigestItem, "title" | "body" | "summary">[]): number[][] {
  const maxItems = MAP_MAX_ITEMS();
  const maxChars = MAP_MAX_CHARS();
  const sizes = rows.map(itemSize);
  const total = sizes.reduce((a, b) => a + b, 0);
  let k = Math.max(Math.ceil(rows.length / maxItems), Math.ceil(total / maxChars), 1);
  for (; ; k++) {
    const chunks: number[][] = Array.from({ length: k }, () => []);
    const loads = new Array<number>(k).fill(0);
    const order = rows.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
    let ok = true;
    for (const i of order) {
      let best = -1;
      for (let c = 0; c < k; c++) {
        if (chunks[c].length >= maxItems) continue;
        // An oversized lone item may exceed CHARS in its own chunk (can't split an article).
        if (chunks[c].length > 0 && loads[c] + sizes[i] > maxChars) continue;
        if (best === -1 || loads[c] < loads[best]) best = c;
      }
      if (best === -1) {
        ok = false;
        break;
      }
      chunks[best].push(i);
      loads[best] += sizes[i];
    }
    if (ok) {
      for (const c of chunks) c.sort((a, b) => a - b);
      return chunks.filter((c) => c.length > 0);
    }
  }
}

/** complete() with one retry — a single flaky map call shouldn't kill the digest. */
async function completeRetry(opts: Parameters<typeof complete>[0]): Promise<string> {
  try {
    return await complete(opts);
  } catch (err) {
    console.warn("[digest] LLM call failed, retrying once:", err instanceof Error ? err.message : err);
    return complete(opts);
  }
}

const MAP_SYSTEM =
  "★ 모든 출력은 반드시 한국어로 작성한다. 중국어·일본어 절대 금지. (영어 고유명사·티커만 예외)\n\n" +
  "너는 다이제스트 1단계 정리자다. 아래는 오늘 선별된 글 전체 중 일부 묶음이다. " +
  "한 건도 빠짐없이, 글마다 `- [번호] 핵심 내용 1~3문장 (종목/테마, 영향: 상승/하락/중립)` 형식으로 압축한다. " +
  "번호는 입력에 적힌 [N]을 그대로 쓴다(새로 매기지 마라). 제목·URL은 쓰지 않는다. " +
  "이 출력은 2단계 종합의 입력이 되므로, 의견 종합은 하지 말고 투자 판단에 쓰일 구체 정보(수치·이벤트·근거)를 보존하는 데 집중한다.";

/** Map stage: partial-summarize each chunk (bounded concurrency), keeping global [N]s. */
async function mapStage(rows: DigestItem[], chunks: number[][], model: string): Promise<string[]> {
  const partials = new Array<string>(chunks.length);
  const runOne = async (ci: number) => {
    const body = chunks[ci].map((i) => renderItem(rows[i], i + 1)).join("\n\n---\n\n");
    partials[ci] = await completeRetry({
      model,
      system: MAP_SYSTEM,
      user: `전체 ${rows.length}건 중 이 묶음 ${chunks[ci].length}건:\n\n${body}`,
      maxTokens: MAP_MAX_TOKENS(),
    });
  };
  for (let i = 0; i < chunks.length; i += MAP_CONCURRENCY) {
    await Promise.all(
      chunks.slice(i, i + MAP_CONCURRENCY).map((_, j) => runOne(i + j)),
    );
  }
  return partials;
}

/** This window's relevant feed picks: period's important + saved items (both date-matched to the window). */
async function fetchFeedRows(start: Date, end: Date): Promise<DigestItem[]> {
  return db
    .select({
      id: articles.id,
      title: articles.title,
      url: articles.url,
      source: sources.label,
      provider: sources.provider,
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
        // window-bounded by feed-entry time, then important OR saved
        gte(analyses.createdAt, start),
        lt(analyses.createdAt, end),
        or(
          eq(analyses.lowPriority, false), // 중요
          eq(analyses.saved, true), //        ⭐저장
        ),
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .then((r) => r.map((x) => ({ ...x, source: x.source ?? "(출처 미상)" })));
}

interface SrcDigest {
  id: number;
  title: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  markdown: string;
}

/** Saved (non-trashed) digests whose period overlaps [startDate, endDate]. */
async function fetchDigestsInRange(startDate: string, endDate: string): Promise<SrcDigest[]> {
  return db
    .select({
      id: digests.id,
      title: digests.title,
      periodStart: digests.periodStart,
      periodEnd: digests.periodEnd,
      markdown: digests.markdown,
    })
    .from(digests)
    .where(
      and(
        isNull(digests.deletedAt),
        lte(digests.periodStart, endDate),
        gte(digests.periodEnd, startDate),
      ),
    )
    .orderBy(digests.periodStart);
}

/** Strip footnote citations + the "참조 원문" block so a digest's prose can feed another LLM pass. */
function stripDigestHtml(md: string): string {
  return md
    .replace(/<sup class="cite"[^>]*>[\s\S]*?<\/sup>/g, "")
    .replace(/\n*<h2>참조 원문<\/h2>[\s\S]*?<\/ol>\s*/g, "")
    .trim();
}

/** LLM synthesis of this window's feed picks → markdown with footnote refs.
 *  Small windows go in one call; large ones run map-reduce (see packChunks). */
async function synthesizeFromFeed(
  rows: DigestItem[],
  startDate: string,
  endDate: string,
  title: string,
  cfg: AnalysisConfig,
  model: string,
): Promise<string> {
  if (!hasLLM()) return buildFallbackMarkdown(title, rows);
  const citeRules =
    "\n\n[인용·링크 규칙(필수)] 글을 언급·요약·추천(특히 '원문 정독 추천')할 때 제목 텍스트나 URL을 본문에 직접 쓰지 마라. " +
    "반드시 위 입력의 글 번호만 대괄호 숫자로 단다(예: [3]). 한 글을 여러 번 언급해도 같은 번호를 쓴다. " +
    "'나머지 한 줄 정리'·'기타' 같은 목록을 포함해 글을 가리키는 모든 항목에 번호를 빠짐없이 단다(누락 금지). " +
    "한 줄에서 여러 글을 묶을 때는 글마다 번호를 단다: [3][5] 또는 [3, 5] 형식(범위 [3-5]도 가능). " +
    "시스템이 이 번호를 윗첨자 각주로 바꿔 하단 '참조 원문' 목록(원문 링크 포함)으로 연결한다. " +
    "'[제목](링크)' 형태가 떠올라도 절대 쓰지 말고 번호만 남겨라.";
  const system =
    "★ 모든 출력은 반드시 한국어로 작성한다. 중국어·일본어 절대 금지. (영어 고유명사·티커만 예외)\n\n" +
    (cfg.digestInstructions?.trim() || DIGEST_SYSTEM) +
    citeRules;

  let report: string;
  if (rows.length <= MAP_MAX_ITEMS()) {
    const user =
      `기간: ${startDate} ~ ${endDate}\n\n1차로 선별된 글 (${rows.length}건). 본문을 읽고 종합하라:\n\n` +
      rows.map((it, i) => renderItem(it, i + 1)).join("\n\n---\n\n");
    report = await completeRetry({ model, system, user, maxTokens: DIGEST_MAX_TOKENS() });
  } else {
    const chunks = packChunks(rows);
    console.log(`[digest] map-reduce: ${rows.length}건 → ${chunks.length}청크 (≤${MAP_MAX_ITEMS()}건/청크)`);
    const partials = await mapStage(rows, chunks, model);
    const user =
      `기간: ${startDate} ~ ${endDate}\n\n` +
      `1차로 선별된 글 ${rows.length}건을 1단계에서 글별로 압축 정리했다(글마다 전역 번호 [N]). ` +
      `아래 정리 목록을 원문 대신 읽고 종합하라. 인용 번호는 입력의 [N]을 그대로 사용한다:\n\n` +
      partials.map((p, i) => `### 묶음 ${i + 1}\n${p.trim()}`).join("\n\n");
    report = await completeRetry({ model, system, user, maxTokens: DIGEST_MAX_TOKENS() });
  }
  return `${linkifyRefs(report.trim(), rows)}\n${sourceLinks(rows)}`;
}

/** LLM synthesis of saved digests (past dates, when the feed is gone). No per-article refs. */
async function synthesizeFromDigests(
  src: SrcDigest[],
  startDate: string,
  endDate: string,
  cfg: AnalysisConfig,
  model: string,
): Promise<string> {
  const body = src
    .map(
      (d, i) =>
        `### 다이제스트 ${i + 1}: ${d.title ?? d.periodStart} (${d.periodStart} ~ ${d.periodEnd})\n` +
        clip(stripDigestHtml(d.markdown), 4000),
    )
    .join("\n\n---\n\n");
  if (!hasLLM()) {
    return `# ${startDate} ~ ${endDate} 종합 (저장 다이제스트 ${src.length}건)\n\n${body}`;
  }
  const system =
    "★ 모든 출력은 반드시 한국어로 작성한다. 중국어·일본어 절대 금지. (영어 고유명사·티커만 예외)\n\n" +
    (cfg.digestInstructions?.trim() || DIGEST_SYSTEM) +
    "\n\n[소스 안내] 아래 입력은 이 기간에 이미 생성된 '다이제스트'들이다(원본 글이 아님). " +
    "이들을 종합해 기간 전체를 관통하는 상위 요약을 만든다. 중복은 합치고 흐름·변화·반복 주제를 정리하라. " +
    "원본 글 링크나 [N] 번호 인용은 쓰지 마라(소스가 다이제스트라 번호 매핑이 없다).";
  const user = `종합 기간: ${startDate} ~ ${endDate}\n\n이미 생성된 다이제스트 ${src.length}건:\n\n${body}`;
  const report = await complete({ model, system, user, maxTokens: DIGEST_MAX_TOKENS() });
  return report.trim();
}

/**
 * After the evening auto-digest, soft-delete this window's non-saved feed picks.
 * Only **important** telegram is kept alive (→ 보관함): its "original" has no URL
 * and is read via the digest's ?article deep link → feed.get (needs a non-deleted
 * row), so sweeping it would break past digests' "피드에서 원문 보기". But
 * **low-priority** telegram (검토 only — a digest never cites it, since digests
 * pull important OR saved) is swept like any other 검토 글.
 */
async function trashWindowFeed(start: Date, end: Date): Promise<number> {
  const rows = await db
    .select({ id: articles.id })
    .from(analyses)
    .innerJoin(articles, eq(analyses.articleId, articles.id))
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .where(
      and(
        eq(analyses.relevant, true),
        eq(analyses.saved, false),
        // keep alive only important telegram; trash everything else in window
        or(ne(sources.provider, "telegram"), eq(analyses.lowPriority, true))!,
        isNull(articles.deletedAt),
        gte(analyses.createdAt, start),
        lt(analyses.createdAt, end),
      ),
    );
  if (rows.length === 0) return 0;
  await db
    .update(articles)
    .set({ deletedAt: new Date() })
    .where(inArray(articles.id, rows.map((r) => r.id)));
  return rows.length;
}

/**
 * Sweep a KST date range's window to trash WITHOUT generating a digest or logging
 * feedback — same soft-delete the 21시 cron does (saved & important-telegram kept).
 * Lets the user tidy past days (whose digests already exist) without polluting the
 * learning signal that a manual trash would create.
 */
export async function sweepWindow(startDate: string, endDate: string): Promise<number> {
  if (!hasDb) return 0;
  const { start, end } = kstRangeBounds(startDate, endDate);
  return trashWindowFeed(start, end);
}

/**
 * Generate a saved digest over a KST 21:00→21:00 window range. Normally
 * synthesizes that window's feed picks; for past dates (or `fromDigests`) it
 * synthesizes the saved digests overlapping the range instead. Inserts a
 * `digests` row (meta marks auto/source). Returns null if nothing to do.
 */
export async function generateDigest(
  opts: GenerateDigestOpts = {},
): Promise<{ id: number; title: string; itemCount: number; trashed: number } | null> {
  if (!hasDb) {
    console.warn("[digest] no DATABASE_URL — skipping.");
    return null;
  }
  const startDate = opts.start ?? kstToday();
  // Slot runs are single-day by definition (they split one day's window).
  const endDate = opts.slot ? startDate : opts.end ?? startDate;
  const title = opts.title?.trim() || (startDate === endDate ? `${startDate}` : `${startDate} ~ ${endDate}`);
  const { start, end } = opts.slot ? slotBounds(startDate, opts.slot) : kstRangeBounds(startDate, endDate);
  const cfg = await settingsRepo.getAnalysisConfig();
  const model = cfg.analysisModel || ANALYSIS_MODEL();

  const rows = opts.fromDigests ? [] : await fetchFeedRows(start, end);
  // Past dates: the window's feed was swept to trash, so fall back to saved
  // digests. (The auto cron never falls back — it just skips an empty day.)
  const useDigests = !!opts.fromDigests || (rows.length === 0 && !opts.auto);

  let markdown: string;
  let meta: Record<string, unknown>;
  if (useDigests) {
    const src = await fetchDigestsInRange(startDate, endDate);
    if (src.length === 0) {
      console.log(`[digest] ${title}: no feed picks and no saved digests in range, skipping.`);
      return null;
    }
    markdown = await synthesizeFromDigests(src, startDate, endDate, cfg, model);
    meta = {
      itemCount: src.length,
      model,
      source: "digests",
      sourceDigestIds: src.map((d) => d.id),
      auto: !!opts.auto,
      ...(opts.slot ? { slot: opts.slot } : {}),
    };
  } else {
    if (rows.length === 0) {
      console.log(`[digest] ${title}: no relevant picks, skipping.`);
      return null;
    }
    markdown = await synthesizeFromFeed(rows, startDate, endDate, title, cfg, model);
    meta = { itemCount: rows.length, model, source: "feed", auto: !!opts.auto, ...(opts.slot ? { slot: opts.slot } : {}) };
  }

  const [res] = await db
    .insert(digests)
    .values({ title, periodStart: startDate, periodEnd: endDate, markdown, meta })
    .$returningId();

  let trashed = 0;
  if (opts.trashFeedAfter && !useDigests) {
    trashed = await trashWindowFeed(start, end);
  }
  console.log(
    `[digest] "${title}": saved (source=${String(meta.source)}, items=${Number(meta.itemCount)}` +
      `${trashed ? `, trashed=${trashed}` : ""}).`,
  );
  return { id: Number(res.id), title, itemCount: Number(meta.itemCount), trashed };
}

type DigestRunResult = { id: number; title: string; itemCount: number; trashed: number } | null;

/** 14시 cron: generate the midday digest (어제21시~오늘14시) if it doesn't exist
 *  yet. NEVER sweeps and never touches the filter memo — that's the 21시 run. */
export async function runMiddayDigest(date = kstToday()): Promise<DigestRunResult> {
  if (await hasAutoDigestFor(date, "midday")) return null;
  return generateDigest({ auto: true, slot: "midday", start: date });
}

/**
 * 21시 routine (digest part): backfill a missed 14시분, generate the 21시분
 * (오늘14시~21시), then sweep the WHOLE day window (어제21시~오늘21시) — but only
 * if the day got at least one auto digest (an undigested day is never swept).
 * Slot guards make this safe to re-run (boot catch-up, manual button).
 */
export async function runDailyDigests(date = kstToday()): Promise<{
  midday: DigestRunResult;
  evening: DigestRunResult;
  middayExisted: boolean;
  eveningExisted: boolean;
  swept: number;
}> {
  const middayExisted = await hasAutoDigestFor(date, "midday");
  const midday = middayExisted ? null : await generateDigest({ auto: true, slot: "midday", start: date });
  const eveningExisted = await hasAutoDigestFor(date, "evening");
  const evening = eveningExisted ? null : await generateDigest({ auto: true, slot: "evening", start: date });
  let swept = 0;
  if (middayExisted || eveningExisted || midday || evening) {
    swept = await sweepWindow(date, date);
  }
  return { midday, evening, middayExisted, eveningExisted, swept };
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
