import assert from "node:assert/strict";
import test from "node:test";
import { stripLoneSurrogates } from "../src/server/analysis/anthropic.js";

/**
 * 2026-08 실장애 회귀 테스트 —
 *   LLM API 400: Failed to parse the request body as JSON:
 *   messages[1].content: unexpected end of hex escape
 *
 * 원인: 프롬프트를 만들 때 slice()가 이모지(서로게이트 페어) 한가운데를 잘라
 * 반쪽(lone surrogate)이 남았고, JSON.stringify가 그것을 `\ud83d`로 내보냈다.
 * Node 파서는 허용하지만 서버 쪽 엄격한 파서(serde_json 등)는 400을 낸다.
 */

const HIGH = "\uD83D"; // 👍의 앞쪽 절반
const LOW = "\uDC4D"; // 👍의 뒤쪽 절반
const EMOJI = HIGH + LOW; // 👍

/** 엄격한 파서 흉내 — high 서로게이트 뒤에 \u가 안 오면 거부(serde_json 동작). */
function strictParseWouldFail(json: string): boolean {
  return /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/.test(json);
}

test("문제 재현 — 이모지 반쪽이 남으면 엄격 파서가 거부할 JSON이 만들어진다", () => {
  const broken = "가나다" + HIGH; // slice가 만들어낸 반쪽
  const body = JSON.stringify({ messages: [{ role: "user", content: broken }] });
  assert.ok(body.includes("\\ud83d"), "lone surrogate가 그대로 직렬화됨");
  assert.equal(strictParseWouldFail(body), true, "엄격 파서라면 400");
});

test("수정 — stripLoneSurrogates 후에는 엄격 파서도 통과한다", () => {
  const fixed = stripLoneSurrogates("가나다" + HIGH);
  const body = JSON.stringify({ messages: [{ role: "user", content: fixed }] });
  assert.equal(strictParseWouldFail(body), false);
  assert.equal(fixed, "가나다", "반쪽은 제거");
});

test("정상 이모지는 보존된다 (과잉 제거 금지)", () => {
  const s = `좋아요 ${EMOJI} 입니다 🚀🇰🇷`;
  assert.equal(stripLoneSurrogates(s), s);
});

test("뒤쪽 반쪽(low surrogate)만 남은 경우도 제거한다", () => {
  assert.equal(stripLoneSurrogates(LOW + "가나다"), "가나다");
});

test("반쪽이 여러 개 섞여 있어도 정상 문자는 모두 살아남는다", () => {
  const s = HIGH + "가" + EMOJI + LOW + "나" + HIGH;
  assert.equal(stripLoneSurrogates(s), "가" + EMOJI + "나");
});

test("빈 문자열·서로게이트 없는 문자열은 그대로", () => {
  assert.equal(stripLoneSurrogates(""), "");
  assert.equal(stripLoneSurrogates("평범한 한글 abc 123"), "평범한 한글 abc 123");
});

test("clip 계열 절단이 이모지 한가운데를 자르지 않는다 (digest·analyze 공통 규칙)", () => {
  // digest.ts / analyze.ts의 clip과 동일한 규칙을 여기서 명제로 고정한다.
  const safeEnd = (s: string, n: number) => {
    const c = s.charCodeAt(n - 1);
    return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
  };
  const text = "가나다" + EMOJI + "라마바";
  const n = 4; // 정확히 이모지 한가운데
  assert.equal(safeEnd(text, n), 3, "한 칸 당겨서 자른다");
  const cut = text.slice(0, safeEnd(text, n));
  assert.equal(strictParseWouldFail(JSON.stringify({ c: cut })), false);
});
