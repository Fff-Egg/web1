import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  isAutomaticAnalysisPeakAvoidanceEnabled,
  kstMinuteOfDay,
  shouldDeferAutomaticAnalysis,
} from "../src/server/analysis/schedule.js";

const before = process.env.ANALYSIS_AVOID_PEAK;

afterEach(() => {
  if (before === undefined) delete process.env.ANALYSIS_AVOID_PEAK;
  else process.env.ANALYSIS_AVOID_PEAK = before;
});

function atKst(hour: number, minute = 0): Date {
  return new Date(`2026-08-25T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
}

test("KST 시각을 자정 기준 분으로 계산한다", () => {
  assert.equal(kstMinuteOfDay(atKst(14, 30)), 14 * 60 + 30);
});

test("자동 분석은 KST 10~13시와 15~19시에만 대기한다", () => {
  for (const [hour, minute] of [[9, 59], [13, 0], [14, 59], [19, 0], [23, 0]]) {
    assert.equal(shouldDeferAutomaticAnalysis(atKst(hour, minute)), false, `${hour}:${minute}`);
  }
  for (const [hour, minute] of [[10, 0], [12, 59], [15, 0], [18, 59]]) {
    assert.equal(shouldDeferAutomaticAnalysis(atKst(hour, minute)), true, `${hour}:${minute}`);
  }
});

test("ANALYSIS_AVOID_PEAK=0이면 피크 회피를 끌 수 있다", () => {
  process.env.ANALYSIS_AVOID_PEAK = "0";
  assert.equal(isAutomaticAnalysisPeakAvoidanceEnabled(), false);
  assert.equal(shouldDeferAutomaticAnalysis(atKst(11)), false);
  assert.equal(shouldDeferAutomaticAnalysis(atKst(16)), false);
});

test("ANALYSIS_AVOID_PEAK은 설정이 없으면 기본 활성화된다", () => {
  delete process.env.ANALYSIS_AVOID_PEAK;
  assert.equal(isAutomaticAnalysisPeakAvoidanceEnabled(), true);
});
