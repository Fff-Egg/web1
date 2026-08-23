import assert from "node:assert/strict";
import test from "node:test";
import { escapeSingleTildes, renderMarkdown } from "../src/client/markdown.js";

test("숫자 범위의 단일 물결표를 거대한 취소선으로 해석하지 않는다", () => {
  const html = renderMarkdown("2026~27년 서버 가격을 15~17% 인상한다.");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /2026~27년/);
  assert.match(html, /15~17%/);
});

test("범위 사이에 들어간 각주 HTML도 문자로 노출되지 않는다", () => {
  const html = renderMarkdown(
    '2026~27년 <sup class="cite"><a href="#ref-18">[18]</a></sup> 가격 15~17%',
  );

  assert.doesNotMatch(html, /<del>|&lt;sup/);
  assert.match(html, /<sup class="cite"><a href="#ref-18">\[18\]<\/a><\/sup>/);
});

test("명시적인 이중 물결표 취소선 문법은 유지한다", () => {
  assert.equal(escapeSingleTildes("정상 ~~취소~~ 정상"), "정상 ~~취소~~ 정상");
  assert.match(renderMarkdown("정상 ~~취소~~ 정상"), /<del>취소<\/del>/);
});
