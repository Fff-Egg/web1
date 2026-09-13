import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { splitWholeText, contentScope, type ReadingCache } from "../src/shared/articleContent.js";
import { extractArticle, enrichArticle, htmlToText, isPublicAddress, publicTarget } from "../src/server/adapters/fullText.js";
import { readWholeArticle } from "../src/server/analysis/fullReading.js";
import { filterRelevant } from "../src/server/analysis/analyze.js";
import { packChunks } from "../src/server/digest/digest.js";
import type { Source, Article } from "../src/server/db/schema.js";

const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_EXTRA_BODY", "DIGEST_MAP_CHARS"] as const;
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });
const source = (provider: Source["provider"]): Source => ({ id: 123456, provider, identifier: "https://example.com", config: null } as Source);
const body = "처음의 주장과 수치.\n" + "중간의 근거와 반론을 읽어야 합니다. ".repeat(1700) + "\n마지막 결론과 조건 TAIL_SENTINEL";
const html = (text: string) => `<html><head><title>기사 제목</title></head><body><nav>사이트 메뉴</nav><article><h1>기사 제목</h1><p>${text}</p></article><footer>푸터 광고</footer></body></html>`;

test("lossless chunking covers the full tail, all whitespace and split emoji", () => {
  for (const value of [body, "가".repeat(11999) + "🚀" + "끝".repeat(13000), "\n".repeat(50000)]) {
    const chunks = splitWholeText(value);
    assert.equal(chunks.join(""), value);
    assert.ok(chunks.every(c => c.length <= 12000 && !/[\uD800-\uDBFF]$/.test(c)));
  }
  assert.deepEqual(splitWholeText(""), []);
});

test("article extraction removes navigation while retaining final paragraphs and table text", () => {
  const extracted = extractArticle(html(body + "</p><table><tr><td>매출 300</td><td>이익 40</td></tr></table><p>최종 단서"), "https://example.com/a");
  assert.match(extracted.text, /TAIL_SENTINEL/); assert.match(extracted.text, /매출 300/); assert.match(extracted.text, /최종 단서/);
  assert.doesNotMatch(extracted.text, /사이트 메뉴|푸터 광고/);
  assert.equal(htmlToText("그대로인 일반 텍스트 < 3"), "그대로인 일반 텍스트 < 3");
  assert.equal(extractArticle(html("본문 근거 ".repeat(100)).replace("<head>", '<head><script type="application/ld+json">{"isAccessibleForFree":false}</script>'), "https://example.com/a").partial, true);
});

test("RSS preview is replaced with accessible article text and blocked pages retain their preview", async () => {
  const item = { externalId: "a", url: "https://example.com/a", body: "짧은 RSS 소개" };
  const full = await enrichArticle(item, source("generic_rss"), async url => ({ html: html(body), url }));
  assert.match(full.body!, /TAIL_SENTINEL/); assert.equal(full.contentMeta?.status, "extracted");
  const blocked = await enrichArticle(item, source("generic_rss"), async () => { throw Error("로그인 또는 접근 권한 필요"); });
  assert.equal(blocked.body, item.body); assert.equal(blocked.contentMeta?.status, "partial");
  assert.match(contentScope(blocked.contentMeta), /일부 수집/);
});

test("social post and linked source remain separate; a failed source never discards successful sources", async () => {
  const item = { externalId: "x1", url: "https://x.com/user/status/1", body: "작성자의 해석 https://t.co/short", linkedUrls: ["https://example.com/good", "https://example.com/bad"] };
  const calls: string[] = [];
  const result = await enrichArticle(item, source("x"), async url => { calls.push(url); if (url.endsWith("bad")) throw Error("원문 HTTP 404"); return { html: html("실제 기사 근거 ".repeat(100)), url }; });
  assert.match(result.body!, /^작성자의 해석/); assert.match(result.body!, /연결 원문 — 게시글 작성자의 말과 구분/);
  assert.match(result.body!, /실제 기사 근거/); assert.equal(result.contentMeta?.links[0].status, "extracted");
  assert.equal(result.contentMeta?.links[1].status, "unavailable"); assert.equal(result.contentMeta?.status, "partial");
  assert.deepEqual(calls, item.linkedUrls);
});

test("fuller RSS and authenticated bodies survive shorter page extraction and paywall previews", async () => {
  const pageText = "원문에서 확인한 앞부분입니다. ".repeat(15);
  const page = html(pageText);
  const extracted = extractArticle(page, "https://example.com/a").text;
  const original = extracted + "\nRSS에만 남아 있는 마지막 조건 TAIL_RSS";
  const item = { externalId: "full-feed", url: "https://example.com/a", body: original };
  const full = await enrichArticle(item, source("generic_rss"), async url => ({ html: page, url }));
  assert.equal(full.body, original);
  const paid = page.replace("<head>", '<head><script>{"isAccessibleForFree":false}</script>');
  const preview = await enrichArticle({ ...item, body: "인증된 원문의 별도 결론 ORIGINAL_END" }, source("generic_rss"), async url => ({ html: paid, url }));
  assert.match(preview.body!, /ORIGINAL_END/); assert.match(preview.body!, /앞부분/);
  assert.equal(preview.contentMeta?.status, "partial");
});

test("private and metadata destinations, credentials and non-web schemes are rejected", async () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "169.254.169.254", "192.168.1.3", "172.20.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const url of ["http://127.0.0.1/x", "http://169.254.169.254/latest", "file:///etc/passwd", "https://user:secret@example.com/a"]) await assert.rejects(publicTarget(url));
  assert.equal(isPublicAddress("1.1.1.1"), true); assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("long text is read fully once, checkpointed, reused, and invalidated when text or instructions change", async () => {
  const inputs: string[] = []; let saved: ReadingCache | undefined;
  const opts = { body, model: "deepseek-flash", invoke: async (call: { user: string }) => { inputs.push(call.user); return `구간의 사실 요약 ${inputs.length}`; }, checkpoint: async (value: ReadingCache) => { saved = structuredClone(value); } };
  const result = await readWholeArticle(opts);
  assert.ok(inputs.length > 1); assert.match(inputs.at(-1)!, /TAIL_SENTINEL/); assert.ok(result.completedAt);
  const count = inputs.length;
  await readWholeArticle({ ...opts, cache: saved }); assert.equal(inputs.length, count);
  await readWholeArticle({ ...opts, body: body + "새로운 결론", cache: saved }); assert.ok(inputs.length > count);
  const next = inputs.length;
  await readWholeArticle({ ...opts, instructions: "수치를 자세히", cache: saved }); assert.ok(inputs.length > next);
});

test("failed chunk checkpoints resume without re-reading successful chunks or saving partial completion", async () => {
  let saved: ReadingCache | undefined; let calls = 0;
  const opts = { body, model: "deepseek-flash", checkpoint: async (c: ReadingCache) => { saved = structuredClone(c); } };
  await assert.rejects(readWholeArticle({ ...opts, invoke: async () => { calls++; if (calls === 2) throw Error("temporary failure"); return "완료한 첫 구간"; } }), /temporary failure/);
  assert.equal(saved?.completedAt, undefined); assert.equal(saved?.text, undefined);
  const totalChunks = splitWholeText(body).length; calls = 0;
  const result = await readWholeArticle({ ...opts, cache: saved, invoke: async () => { calls++; return "나머지 구간"; } });
  assert.equal(calls, totalChunks - 1); assert.match(result.text!, /완료한 첫 구간/); assert.ok(result.completedAt);
});

test("short text bypasses extra LLM calls; classifier and digest packing no longer cut the tail", async () => {
  const short = "본문 ".repeat(2000) + "TAIL_SHORT";
  const reading = await readWholeArticle({ body: short, model: "deepseek-flash", invoke: async () => { throw Error("should not call"); } });
  assert.equal(reading.text, short);
  process.env.LLM_BASE_URL = "https://api.deepseek.com"; process.env.LLM_API_KEY = "test-key"; delete process.env.LLM_EXTRA_BODY;
  globalThis.fetch = async (_url, init) => { assert.match(JSON.parse(String(init?.body)).messages[1].content, /TAIL_SHORT/); return new Response(JSON.stringify({ choices: [{ message: { content: '{"relevant":true,"important":true,"summary":"한국어 요약"}' }, finish_reason: "stop" }] })); };
  await filterRelevant({ id: 1, title: "제목", body: short, url: "https://example.com/a" } as Article, { instructions: "전체 읽기" });
  process.env.DIGEST_MAP_CHARS = "10000";
  const packed = packChunks([{ title: "1", body: short, summary: "" }, { title: "2", body: short, summary: "" }]);
  assert.equal(packed.length, 2);
});
