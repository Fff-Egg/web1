import assert from "node:assert/strict";
import test from "node:test";
import { kstMidnight, previewBacklogCleanup, trashUnanalyzedBefore, undoLastBacklogCleanup } from "../src/server/repo/backlogCleanup.js";

test("cleanup cutoff is KST midnight of the chosen date", () => {
  assert.equal(kstMidnight("2026-11-05").toISOString(), "2026-11-04T15:00:00.000Z");
  assert.throws(() => kstMidnight("2026/11/05"), /YYYY-MM-DD/);
  assert.throws(() => kstMidnight("2026-13-40"), /올바른 날짜/);
});

test("without a database the cleanup is a safe no-op", async () => {
  assert.deepEqual(await previewBacklogCleanup("2026-11-05"), { date: "2026-11-05", cutoff: "2026-11-04T15:00:00.000Z", before: 0, kept: 0 });
  assert.equal((await trashUnanalyzedBefore("2026-11-05")).trashed, 0);
  assert.deepEqual(await undoLastBacklogCleanup(), { restored: 0 });
});
