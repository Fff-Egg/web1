import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBacktestEpisodes,
  evaluateEpisode,
  runKFearBacktest,
  type KFearBacktestDay,
} from "../src/client/pages/kfearBacktest.js";

const DAY = 86_400_000;

function sampleRows(length = 140): KFearBacktestDay[] {
  return Array.from({ length }, (_, i) => ({
    t: Date.UTC(2020, 0, 1) + i * DAY,
    open: 100 + i * 0.1,
    close: 100 + i * 0.1,
    fear: i === 5 ? 95 : 70,
    s1: i === 5,
    s3: i === 5,
    amount: i === 5 ? 100 : i === 6 ? 90 : i === 7 ? 80 : i > 7 ? 80 : 50,
    amountPercentile: i === 5 ? 0.96 : 0.5,
  }));
}

test("backtest creates one merged episode and all five strategy outputs", () => {
  const rows = sampleRows();
  const episodes = buildBacktestEpisodes(rows);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].decline1Index, 6);
  assert.equal(episodes[0].decline2Index, 7);
  assert.equal(episodes[0].decline3Index, null);

  const report = runKFearBacktest(rows);
  assert.equal(report.nextSession.strategies.A.independentEpisodes, 1);
  assert.equal(report.nextSession.strategies.B.independentEpisodes, 1);
  assert.equal(report.nextSession.strategies.C.independentEpisodes, 1);
  assert.equal(report.nextSession.strategies.D.independentEpisodes, 0);
  assert.equal(report.nextSession.strategies.E.independentEpisodes, 1);
  assert.equal(report.nextSession.stagedProgress.reachedStage2RatePct, 100);
});

test("staged MDD uses daily 60% equity plus cash, then the second 40% leg", () => {
  const prices = [100, 90, 80, ...Array<number>(19).fill(100)];
  const rows: KFearBacktestDay[] = prices.map((close, i) => ({
    t: Date.UTC(2025, 0, 1) + i * DAY,
    open: close,
    close,
    fear: i === 0 ? 95 : 70,
    s1: i === 0,
    s3: i === 0,
    amount: i === 0 ? 100 : i === 1 ? 90 : i === 2 ? 80 : 80,
    amountPercentile: i === 0 ? 0.96 : 0.5,
  }));
  const episode = buildBacktestEpisodes(rows)[0];
  const staged = evaluateEpisode(rows, episode, "E", "1m", "signal-close");
  const full = evaluateEpisode(rows, episode, "A", "1m", "signal-close");
  assert.ok(staged);
  assert.ok(full);
  assert.ok(Math.abs(staged.returnPct - 10) < 1e-9);
  assert.ok(Math.abs(staged.mddPct - -12) < 1e-9);
  assert.ok(Math.abs(full.mddPct - -20) < 1e-9);
});

test("without Stage 2 the uninvested 40% stays cash and next-session can use a close proxy", () => {
  const rows: KFearBacktestDay[] = Array.from({ length: 24 }, (_, i) => ({
    t: Date.UTC(2025, 5, 1) + i * DAY,
    close: i === 0 ? 100 : 110,
    fear: i === 0 ? 95 : 70,
    s1: i === 0,
    s3: i === 0,
    amount: i === 0 ? 100 : 100,
    amountPercentile: i === 0 ? 0.96 : 0.5,
  }));
  const episode = buildBacktestEpisodes(rows)[0];
  const closeOutcome = evaluateEpisode(rows, episode, "E", "1m", "signal-close");
  const nextOutcome = evaluateEpisode(rows, episode, "E", "1m", "next-session");
  assert.ok(closeOutcome);
  assert.ok(nextOutcome);
  assert.ok(Math.abs(closeOutcome.returnPct - 6) < 1e-9);
  assert.equal(nextOutcome.usedCloseProxy, true);
});
