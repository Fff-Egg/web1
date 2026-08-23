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

test("X의 종목명·티커만 있는 shell은 원문 확인 대상으로 보낸다", () => {
  assert.equal(
    needsSourceReview({ title: "$NVDA", body: "$NVDA", url: "https://x.com/user/status/2" }),
    true,
  );
  assert.equal(
    needsSourceReview({ title: "삼성전자 HBM", body: "삼성전자 HBM", url: "https://x.com/user/status/3" }),
    true,
  );
});

test("내용이 있는 짧은 문장과 일반 RSS 종목명은 자동 원문확인으로 보내지 않는다", () => {
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

test("수집 마커와 안내 요약을 인식한다", () => {
  assert.equal(
    needsSourceReview({ body: SOURCE_REVIEW_MARKER, url: "https://x.com/user/status/5" }),
    true,
  );
  assert.match(sourceReviewSummary({ title: "첨부 아티클" }), /원문 확인 필요/);
});
