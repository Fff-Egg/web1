import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_REVIEW_MARKER,
  needsSourceReview,
  sourceReviewSummary,
} from "../src/shared/sourceReview.js";

test("빈 본문은 원문 확인 대상으로 보존한다", () => {
  assert.equal(
    needsSourceReview({ title: "X Article", body: "", url: "https://x.com/user/status/1" }),
    true,
  );
});

test("X의 cashtag-only shell은 원문 확인 대상으로 보낸다", () => {
  assert.equal(
    needsSourceReview({ title: "$NVDA", body: "$NVDA", url: "https://x.com/user/status/2" }),
    true,
  );
  assert.equal(
    needsSourceReview({ title: "$LPTH 🎯", body: "$LPTH 🎯", url: "https://x.com/user/status/21" }),
    true,
  );
});

test("일반 종목명·짧은 주장·찌라시는 원문 확인으로 과잉 분류하지 않는다", () => {
  assert.equal(
    needsSourceReview({ title: "삼성전자 HBM", body: "삼성전자 HBM", url: "https://x.com/user/status/3" }),
    false,
  );
  assert.equal(
    needsSourceReview({
      title: "X Article",
      body: "제12차 전력수급기본계획에서 2040년 최대전력 수요 전망이 26GW 상향됐다.",
      url: "https://x.com/i/article/123",
    }),
    false,
  );
  assert.equal(
    needsSourceReview({
      title: "두나무 나스닥 상장",
      body: "[단독] 두나무가 미국 SEC 위원장을 면담하고 나스닥 상장 절차에 속도를 내고 있다는 주장이 제기됐다.",
      url: "https://x.com/user/status/31",
    }),
    false,
  );
  assert.equal(
    needsSourceReview({
      title: "Neutron 일정 논쟁",
      body: "RT RT @ASML2002: Most people are still arguing about 'Will Neutron slip another quarter'.",
      url: "https://x.com/user/status/32",
    }),
    false,
  );
});

test("내용이 있는 문장과 일반 RSS 종목명은 자동 원문확인으로 보내지 않는다", () => {
  assert.equal(
    needsSourceReview({
      title: "전력 부족",
      body: "전력 부족으로 데이터센터 허가가 6개월 지연됐다.",
      url: "https://x.com/user/status/4",
    }),
    false,
  );
  assert.equal(
    needsSourceReview({ title: "삼성전자", body: "삼성전자", url: "https://example.com/a" }),
    false,
  );
});

test("링크·이모지뿐인 글과 내용 없는 반응문은 원문 확인 대상으로 보낸다", () => {
  assert.equal(
    needsSourceReview({ title: "😎", body: "😎 https://t.co/example", url: "https://x.com/user/status/41" }),
    true,
  );
  assert.equal(
    needsSourceReview({ title: "excited to see", body: "excited to see", url: "https://x.com/user/status/42" }),
    true,
  );
  assert.equal(
    needsSourceReview({
      title: "RT This is elite work.",
      body: "RT RT @outliercapx: This is elite work.",
      url: "https://x.com/user/status/43",
    }),
    true,
  );
  assert.equal(
    needsSourceReview({
      title: "자료공유 감사합니다",
      body: "자료공유 감사합니다.",
      url: "https://x.com/user/status/44",
    }),
    true,
  );
});

test("수집 마커와 안내 요약을 인식한다", () => {
  assert.equal(
    needsSourceReview({ body: SOURCE_REVIEW_MARKER, url: "https://x.com/user/status/5" }),
    true,
  );
  assert.match(sourceReviewSummary({ title: "첨부 아티클" }), /원문 확인 필요/);
});
