import assert from "node:assert/strict";
import test from "node:test";
import { computeLiveUsConfirmation, computeStagedExecutionTimeline, type StagedSignalInput } from "../src/client/pages/kfearStaged.js";

const DAY = 86_400_000;
const row = (
  i: number,
  amount: number,
  amountPercentile: number,
  extra: Partial<StagedSignalInput> = {},
): StagedSignalInput => ({
  t: Date.UTC(2025, 3, 8) + i * DAY,
  fear: 50,
  s1: false,
  s3: false,
  amount,
  amountPercentile,
  officialS2: false,
  ...extra,
});

test("Stage 1 enters 60%, first decline adds nothing, and Stage 2 adds only 40%", () => {
  const out = computeStagedExecutionTimeline([
    row(0, 70, 0.5),
    row(1, 100, 0.96, { fear: 94, s1: true, s3: true }),
    row(2, 90, 0.7),
    row(3, 80, 0.6, { officialS2: true }),
  ]);
  assert.equal(out[1].stage1EntryEvent, true);
  assert.equal(out[1].stagedTargetPct, 60);
  assert.equal(out[1].stagedAddedPct, 60);
  assert.equal(out[2].decline1, true);
  assert.equal(out[2].decline2, false);
  assert.equal(out[2].stagedAddedPct, 0);
  assert.equal(out[3].stage2UpgradeEvent, true);
  assert.equal(out[3].stagedTargetPct, 100);
  assert.equal(out[3].stagedAddedPct, 40);
  assert.equal(out[3].stageEpisodeId, out[1].stageEpisodeId);
});

test("a re-increase or tie is not a strict two-day decline", () => {
  for (const last of [95, 90]) {
    const out = computeStagedExecutionTimeline([
      row(0, 70, 0.5),
      row(1, 100, 0.96, { fear: 94, s1: true, s3: true }),
      row(2, 90, 0.7),
      row(3, last, 0.7),
    ]);
    assert.equal(out[3].decline2, false);
    assert.equal(out[3].stage2UpgradeEvent, false);
  }
});

test("an expired spike or a spike without Stage 1 cannot create Stage 2", () => {
  const expired = [
    row(0, 50, 0.5),
    row(1, 100, 0.96, { fear: 95, s1: true, s3: true }),
    row(2, 100, 0.5),
    row(3, 110, 0.5),
    row(4, 120, 0.5),
    row(5, 130, 0.5),
    row(6, 140, 0.5),
    row(7, 150, 0.5),
    row(8, 140, 0.5),
    row(9, 130, 0.5),
  ];
  const expiredOut = computeStagedExecutionTimeline(expired);
  assert.equal(expiredOut[9].decline2, true);
  assert.equal(expiredOut[9].spikeWithin6Days, false);
  assert.equal(expiredOut[9].stage2UpgradeEvent, false);

  const noStage1 = computeStagedExecutionTimeline([
    row(0, 70, 0.5),
    row(1, 100, 0.96, { fear: 89, s1: true, s3: true }),
    row(2, 90, 0.7),
    row(3, 80, 0.6),
  ]);
  assert.equal(noStage1[3].decline2, true);
  assert.equal(noStage1[3].stage2UpgradeEvent, false);
});

test("experimental Stage 2 can fire while official STRONG remains false", () => {
  const out = computeStagedExecutionTimeline([
    row(0, 70, 0.5),
    row(1, 100, 0.96, { fear: 95, s1: true, s3: true }),
    row(2, 90, 0.7),
    row(3, 80, 0.6, { fear: 75, s1: true, s3: false, officialS2: true }),
  ]);
  assert.equal(out[3].stage2UpgradeEvent, true);
  assert.equal(out[3].officialS2, true);
  assert.equal(out[3].officialStrong, false);
});

test("live US confirmation never reads a future tier", () => {
  const timeline = [
    { t: Date.UTC(2025, 3, 8), tier: null, episodeStart: false },
    { t: Date.UTC(2025, 3, 10), tier: 1 as const, episodeStart: true },
  ];
  assert.deepEqual(computeLiveUsConfirmation(timeline, Date.UTC(2025, 3, 9)), {
    usTierNow: null,
    usConfirmedAsOfDate: null,
    usConfirmationLabel: "미국 확인 없음",
  });
  assert.deepEqual(computeLiveUsConfirmation(timeline, Date.UTC(2025, 3, 10)), {
    usTierNow: 1,
    usConfirmedAsOfDate: "2025-04-10",
    usConfirmationLabel: "Tier1 확인",
  });
});
