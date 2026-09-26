import assert from "node:assert/strict";
import test from "node:test";
import { enrichArticle } from "../src/server/adapters/fullText.js";
import { readWholeArticle } from "../src/server/analysis/fullReading.js";
import type { Source } from "../src/server/db/schema.js";

const source = (provider: Source["provider"]): Source => ({ id: 987654, provider, config: { bodySelector: "article" } } as Source);
const page = (text: string, title = "기사 제목") => `<html><head><title>${title}</title></head><body><article>${text}</article></body></html>`;
const sentences = Array.from({ length: 180 }, (_, i) => `문단 ${i}: 매출은 100이고, 이익은 10이다. 반대 근거와 최종 조건도 확인한다.`);
const text = sentences.join(" ");

test("formatting-only RSS/page differences retain one complete body and avoid unnecessary long-reading calls", async () => {
  assert.ok(text.length > 6000 && text.length < 12000);
  const item = { externalId: "rss", title: "기사 제목", url: "https://example.com/article", body: text };
  const result = await enrichArticle(item, source("generic_rss"), async url => ({ html: page(sentences.map(s => `<p>${s}</p>`).join("")), url }));
  assert.equal(result.body, text);
  assert.match(result.body!, /문단 179:/);
  let calls = 0;
  const reading = await readWholeArticle({ body: result.body!, model: "unused", invoke: async () => { calls++; return "unnecessary summary"; } });
  assert.equal(calls, 0);
  assert.equal(reading.text, text);
  assert.equal(item.body, text, "the supplied source text must not be modified");
});

test("different known title wrappers do not duplicate the body or discard either title", async () => {
  const original = `피드 기사 제목\n${text}`;
  const result = await enrichArticle({ externalId: "rss", title: "피드 기사 제목", url: "https://example.com/article", body: original }, source("generic_rss"), async url => ({ html: page(`<h1>원문 기사 제목</h1><p>${text}</p>`, "원문 기사 제목"), url }));
  assert.ok(result.body!.length < 12000);
  assert.equal(result.body!.split("문단 179:").length - 1, 1);
  assert.match(result.body!, /피드 기사 제목/);
  assert.match(result.body!, /원문 기사 제목/);
});

test("a fuller RSS body with unique commentary and a shorter paywall extraction retains its full addendum", async () => {
  const original = `피드 기사 제목\n${text}\n작성자 추가 해석: 이전 전망과 달리 매출은 101일 수도 있다. UNIQUE_COMMENTARY`;
  const result = await enrichArticle({ externalId: "rss", title: "피드 기사 제목", url: "https://example.com/article", body: original }, source("generic_rss"), async url => ({ html: page(`<h1>원문 기사 제목</h1><p>${text}</p>`, "원문 기사 제목").replace("<head>", '<head><script>{"isAccessibleForFree":false}</script>'), url }));
  assert.match(result.body!, /UNIQUE_COMMENTARY/);
  assert.match(result.body!, /매출은 101/);
  assert.equal(result.body!.split("문단 179:").length - 1, 1);
  assert.equal(result.contentMeta?.status, "partial");
});

test("RSS and page disagreement is preserved, including a final number that is a substring of another", async () => {
  const common = "동일한 배경 사실과 별도로 최종 예상치를 확인한다. ".repeat(8);
  const original = `${common}최종 예상 매출은 10`;
  for (const changed of ["100", "10.5", "10%", "-10"]) {
    const result = await enrichArticle({ externalId: "rss", url: "https://example.com/article", body: original }, source("generic_rss"), async url => ({ html: page(`<p>${common}최종 예상 매출은 ${changed}</p>`), url }));
    assert.match(result.body!, /피드 제공 본문/);
    assert.ok(result.body!.endsWith(original));
    assert.ok(result.body!.includes(`매출은 ${changed}`));
  }
});

test("tracking variants fetch and append one article while preserving all source references", async () => {
  const links = [
    "https://example.com/article?utm_source=telegram",
    "https://example.com/article?utm_medium=social&utm_campaign=update",
    "https://example.com/article?fbclid=tracker",
  ];
  const calls: string[] = [];
  const original = "작성자의 고유한 해석과 반론";
  const result = await enrichArticle({ externalId: "post", body: original, linkedUrls: links }, source("telegram"), async url => { calls.push(url); return { html: page(`<p>${text}</p>`), url }; });
  assert.equal(calls.length, 1);
  assert.equal(result.body!.split("문단 179:").length - 1, 1);
  assert.ok(result.body!.startsWith(original));
  for (const url of links) assert.ok(result.body!.includes(`주소: ${url}`));
  assert.deepEqual(result.contentMeta?.sourceUrls, links);
  assert.deepEqual(result.contentMeta?.links.map(link => [link.url, link.status]), links.map(url => [url, "extracted"]));
});

test("redirect aliases and whitespace-only mirrored articles keep one body and their distinct titles/addresses", async () => {
  const canonical = "https://example.com/article";
  const links = ["https://short.example/first", canonical, "https://mirror.example/copy"];
  const calls: string[] = [];
  const result = await enrichArticle({ externalId: "post", body: "게시자 본문", linkedUrls: links }, source("x"), async url => {
    calls.push(url);
    const mirrored = url.includes("mirror");
    const title = mirrored ? "미러 원문 제목" : "원문 제목";
    return { html: page(`<h1>${title}</h1>${sentences.map(s => `<p>${s}</p>`).join(mirrored ? "\n" : "")}`, title), url: mirrored ? url : canonical };
  });
  assert.deepEqual(calls, [links[0], links[2]], "an observed redirect target can reuse the first fetch");
  assert.equal(result.body!.split("문단 179:").length - 1, 1);
  assert.match(result.body!, /미러 원문 제목/);
  assert.ok(result.body!.includes(`원문 주소: ${canonical}`));
  assert.deepEqual(result.contentMeta?.links.map(link => link.url), links);
});

test("functional queries remain separate and different facts are never similarity-deduplicated", async () => {
  const links = ["https://example.com/article?id=1&utm_source=feed", "https://example.com/article?id=2&utm_source=feed", "https://example.com/article?id=1&ref=updated"];
  const calls: string[] = [];
  const unique = ["매출 100, 이익 10", "매출 101, 이익 10", "매출 100, 이익 11"];
  const result = await enrichArticle({ externalId: "post", body: "작성자 의견", linkedUrls: links }, source("telegram"), async url => {
    calls.push(url);
    return { html: page(`<p>${text} 최종 실적: ${unique[links.indexOf(url)]}</p>`), url };
  });
  assert.deepEqual(calls, links);
  for (const fact of unique) assert.ok(result.body!.includes(`최종 실적: ${fact}`));
  assert.equal(result.body!.split("문단 179:").length - 1, 3);
});

test("failed tracking variant does not suppress a later available URL or its successful body", async () => {
  const links = ["https://example.com/article?utm_source=bad", "https://example.com/article?utm_source=good"];
  let calls = 0;
  const result = await enrichArticle({ externalId: "post", body: "작성자 의견", linkedUrls: links }, source("telegram"), async url => {
    calls++;
    if (url === links[0]) throw Error("원문 HTTP 403");
    return { html: page(`<p>${text}</p>`), url };
  });
  assert.equal(calls, 2);
  assert.match(result.body!, /문단 179:/);
  assert.equal(result.contentMeta?.links[0].status, "unavailable");
  assert.equal(result.contentMeta?.links[1].status, "extracted");
});
