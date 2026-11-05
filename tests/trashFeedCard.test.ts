import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrashFeedCard } from "../src/client/components/TrashFeedCard.js";
import type { FeedItem } from "../src/client/data/client.js";

const fixture: FeedItem = {
  id: 7,
  title: "데이터센터 인허가 지연에 대한 현장 관찰",
  url: "https://example.com/article/7",
  author: null,
  publishedAt: null,
  sourceLabel: "현장 관찰",
  provider: "generic_rss",
  summary: "주민 반대로 건설 일정에 불확실성이 생겼다는 주장.",
  implications: null,
  fullText: null,
  tickers: [],
  themes: [],
  impact: "neutral",
  lowPriority: true,
};

function render(overrides: Partial<FeedItem> = {}, disabled = false) {
  return renderToStaticMarkup(createElement(TrashFeedCard, {
    item: { ...fixture, ...overrides },
    checked: false,
    disabled,
    onToggle() {},
    onRestore() {},
    onPurge() {},
  }));
}

test("휴지통에서 전체 제목·요약·원문 링크·삭제 전 분류를 확인한다", () => {
  const html = render();
  assert.ok(html.includes(fixture.title!));
  assert.ok(html.includes(fixture.summary!));
  assert.match(html, /삭제 전 분류: 검토 대상/);
  assert.match(html, /href="https:\/\/example.com\/article\/7"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, />복원<\/button>/);
  assert.doesNotMatch(html, /truncate/);
});

test("링크 없는 텔레그램 글은 보관된 본문을 펼쳐 읽을 수 있다", () => {
  const html = render({ provider: "telegram", url: null, body: "수집한 원문\n두 번째 줄" });
  assert.match(html, /수집된 본문 펼치기/);
  assert.match(html, /수집한 원문\n두 번째 줄/);
  assert.doesNotMatch(html, /원문 보기/);
});

test("원문 확인 분류는 낮은 중요도와 구분하고 없는 요약을 만들지 않는다", () => {
  const html = render({ needsSourceReview: true, lowPriority: true, summary: null });
  assert.match(html, /삭제 전 분류: 원문 확인/);
  assert.doesNotMatch(html, /삭제 전 분류: 검토 대상/);
  assert.match(html, /저장된 요약이 없습니다/);
});

test("외부 글 내용은 HTML로 실행하지 않고 비 HTTP 원문 링크를 숨긴다", () => {
  const html = render({ summary: "<script>alert(1)</script>", url: "javascript:alert(1)" });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|javascript:|원문 보기/);
});

test("복원·삭제 처리 중에는 카드 선택과 중복 작업을 막는다", () => {
  const html = render({}, true);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});
