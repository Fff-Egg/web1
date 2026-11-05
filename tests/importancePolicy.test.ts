import assert from "node:assert/strict";
import test from "node:test";
import {
  LOW_PRIORITY_REASONS,
  shouldTreatAsImportant,
} from "../src/shared/analysis.js";

test("기술 분석·개인 해석·미확인은 모델이 낮게 봐도 중요로 복구한다", () => {
  assert.equal(shouldTreatAsImportant({ important: false }), true);
  assert.equal(shouldTreatAsImportant({ important: false, lowReason: "개인해석" }), true);
  assert.equal(shouldTreatAsImportant({ important: false, lowReason: "직접실적없음" }), true);
  assert.equal(shouldTreatAsImportant({ important: false, lowReason: "미확인" }), true);
});

test("정보 증가분이 없는 다섯 사유만 검토대상으로 허용한다", () => {
  for (const reason of LOW_PRIORITY_REASONS) {
    assert.equal(shouldTreatAsImportant({ important: false, lowReason: reason }), false, reason);
  }
  assert.equal(shouldTreatAsImportant({ important: true, lowReason: null }), true);
  assert.equal(shouldTreatAsImportant(null), true);
});
