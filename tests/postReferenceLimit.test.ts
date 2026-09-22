import assert from "node:assert/strict";
import test from "node:test";
import { enrichArticle, htmlToText } from "../src/server/adapters/fullText.js";
import { contentScope } from "../src/shared/articleContent.js";
import { readWholeArticle } from "../src/server/analysis/fullReading.js";
import type { Source } from "../src/server/db/schema.js";

const source = (provider: Source["provider"]) => ({ id: 987655, provider, config: { bodySelector: "article" } }) as Source;
const urls = Array.from({ length: 11 }, (_, i) => `https://reference.example/article/${i}`);
const articlePage = `<html><head><title>참고 자료</title></head><body><article>${"서로 다른 근거와 조건을 확인하는 문장입니다. ".repeat(10)}</article></body></html>`;

test("four or eleven parent references preserve the full original and make no linked fetch or long-reading call", async () => {
  for (const provider of ["x", "telegram"] as const) {
    for (const count of [4, 11]) {
      const body = `시작 주장\n${"작성자의 해석과 근거 및 반론. ".repeat(100)}\n${urls.slice(0, count).join("\n")}\n마지막 결론 🚀`;
      let fetches = 0, readings = 0;
      const result = await enrichArticle({ externalId: "many", body }, source(provider), async () => {
        fetches++; throw Error("must not open any reference, even the first three");
      });
      assert.equal(fetches, 0);
      assert.equal(result.body, body);
      assert.equal(result.contentMeta?.status, "post");
      assert.deepEqual(result.contentMeta?.linkExpansion, { maxLinks: 3, linkCount: count, skipped: true });
      assert.ok(result.contentMeta?.links.every(link => link.status === "skipped"));
      assert.deepEqual(result.contentMeta?.links.map(link => link.url), urls.slice(0, count));
      assert.match(contentScope(result.contentMeta), /연결 자료 수집 생략/);
      assert.doesNotMatch(contentScope(result.contentMeta), /일부 수집|미수집/);
      const reading = await readWholeArticle({ body: result.body!, meta: result.contentMeta, model: "unused",
        invoke: async () => { readings++; return "not needed"; } });
      assert.equal(readings, 0);
      assert.equal(reading.text, body);
    }
  }
});

test("exactly three references still fetch all three and do not count links inside their pages", async () => {
  const calls: string[] = [];
  const result = await enrichArticle({ externalId: "three", body: "작성자 원문", linkedUrls: urls.slice(0, 3) }, source("x"), async url => {
    calls.push(url);
    return { url, html: articlePage.replace("</article>", `${urls.map(href => `<a href="${href}">문서</a>`).join(" ")}</article>`) };
  });
  assert.deepEqual(calls, urls.slice(0, 3));
  assert.deepEqual(result.contentMeta?.linkExpansion, { maxLinks: 3, linkCount: 3, skipped: false });
  assert.ok(result.contentMeta?.links.every(link => link.status === "extracted"));
  assert.match(result.body!, /연결 원문 —/);
});

test("parent reference count excludes self, duplicate URL representations and known tracking variants", async () => {
  const own = "https://x.com/writer/status/1";
  const supplied = [...urls.slice(0, 3), `${urls[0]}?utm_source=feed`, own];
  const body = `<p>작성자 원문</p><a href="${urls[0]}">동일 링크</a> https://t.co/alias https://t.co/another`;
  const calls: string[] = [];
  const result = await enrichArticle({ externalId: "dedupe", url: own, body, linkedUrls: supplied }, source("x"), async url => {
    calls.push(url); return { html: articlePage, url };
  });
  assert.deepEqual(calls, urls.slice(0, 3));
  assert.equal(result.contentMeta?.linkExpansion?.linkCount, 3);
  assert.equal(result.contentMeta?.linkExpansion?.skipped, false);
  assert.deepEqual(result.contentMeta?.sourceUrls, supplied);
  assert.ok(result.body!.startsWith(htmlToText(body)));
});

test("HTML anchors and supplied hidden links count before requests; original article pages are unaffected", async () => {
  const body = `<p>원문 전체</p>${urls.slice(0, 4).map(href => `<a href="${href}">참고</a>`).join(" ")}`;
  for (const item of [{ externalId: "anchors", body }, { externalId: "supplied", body: "원문", linkedUrls: urls.slice(0, 4) }]) {
    const result = await enrichArticle(item, source("telegram"), async () => { throw Error("must not fetch"); });
    assert.equal(result.body, htmlToText(item.body));
    assert.equal(result.contentMeta?.linkExpansion?.skipped, true);
  }
  const calls: string[] = [];
  const result = await enrichArticle({ externalId: "rss", url: "https://news.example/original", body }, source("generic_rss"), async url => {
    calls.push(url); return { html: articlePage, url };
  });
  assert.deepEqual(calls, ["https://news.example/original"]);
  assert.equal(result.contentMeta?.linkExpansion, undefined);
  assert.equal(result.contentMeta?.status, "extracted");
});

test("HTML-escaped and decoded representations of the same three references count once", async () => {
  const links = urls.slice(0, 3).map(url => `${url}?id=1&lang=en`);
  const body = `<p>원문</p>${links.map(href => `<a href="${href.replace(/&/g, "&amp;")}">자료</a>`).join(" ")}`;
  const calls: string[] = [];
  const result = await enrichArticle({ externalId: "entities", body, linkedUrls: links }, source("telegram"), async url => {
    calls.push(url); return { html: articlePage, url };
  });
  assert.deepEqual(calls, links);
  assert.equal(result.contentMeta?.linkExpansion?.linkCount, 3);
  assert.equal(result.contentMeta?.linkExpansion?.skipped, false);
});
