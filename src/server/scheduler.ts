import cron from "node-cron";
import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import {
  kstToday,
  kstHour,
  hasAutoDigestFor,
  runMiddayDigest,
  runDailyDigests,
  middayHour,
  currentWindowDate,
  slotBounds,
} from "./digest/digest.js";
import { feedbackRepo } from "./repo/feedback.js";
import { hasDb } from "./db/client.js";
import { hasLLM } from "./analysis/anthropic.js";

/** 14시 routine: midday digest (어제21시~오늘14시) ONLY — no sweep, no memo. */
async function runMiddayRoutine(): Promise<void> {
  try {
    const r = await runMiddayDigest();
    if (r) console.log(`[scheduler] midday digest: "${r.title}" (${r.itemCount} items)`);
  } catch (err) {
    console.error("[scheduler] midday digest failed:", err);
  }
}

/** 21시 routine: fold the day's feedback into the filter memo, then generate
 *  the digests (backfilling a missed 14시분) and sweep the whole day's window. */
async function runEveningRoutine(): Promise<void> {
  try {
    const fx = await feedbackRepo.refreshGuidance();
    console.log(`[scheduler] filter memo: ${fx.updated ? "updated" : "no change"} (new=${fx.newCount}, total=${fx.total})`);
  } catch (err) {
    console.error("[scheduler] filter memo refresh failed:", err);
  }
  try {
    const r = await runDailyDigests();
    const part = (label: string, d: { title: string; itemCount: number } | null, existed: boolean) =>
      d ? `${label}="${d.title}" (${d.itemCount} items)` : `${label}=${existed ? "exists" : "empty"}`;
    console.log(
      `[scheduler] digest: ${part("midday", r.midday, r.middayExisted)}, ` +
        `${part("evening", r.evening, r.eveningExisted)}, swept=${r.swept}`,
    );
  } catch (err) {
    console.error("[scheduler] digest failed:", err);
  }
}

/** node-cron can't replay a missed time; if a boundary or midday run was skipped
 *  (e.g. a deploy restarted the server across that hour), run it once on boot.
 *  The two checks are independent (midday and boundary can fall on different
 *  calendar days when the boundary is early, e.g. 07시). Slot guards in digest.ts
 *  make these double-run safe. */
async function catchUpRoutines(digestHour: number): Promise<void> {
  try {
    // Boundary (HH:00) run for the window that closed this morning.
    if (kstHour() >= digestHour && !(await hasAutoDigestFor(kstToday(), "evening"))) {
      console.log(`[scheduler] catch-up: ${digestHour}:00 boundary run was missed — running now.`);
      await runEveningRoutine(); // backfills the midday분 too
    }
    // Midday run for the CURRENT window, if its midday split time has passed.
    const wd = currentWindowDate();
    if (Date.now() >= slotBounds(wd, "midday").end.getTime() && !(await hasAutoDigestFor(wd, "midday"))) {
      console.log(`[scheduler] catch-up: midday run was missed — running now.`);
      await runMiddayRoutine();
    }
  } catch (err) {
    console.error("[scheduler] catch-up failed:", err);
  }
}

/**
 * Background schedulers. Phase 1 wires the collection loop. The analysis
 * pipeline (Phase 3) and the evening digest cron (Phase 4) hook in here.
 */
export function startSchedulers(): void {
  if (!hasDb) {
    console.warn("[scheduler] no DATABASE_URL — collection disabled (in-memory dev mode).");
    return;
  }
  const intervalMin = Number(process.env.COLLECT_INTERVAL_MIN ?? 30);
  console.log(`[scheduler] collection every ${intervalMin}m`);

  const tick = async () => {
    try {
      const c = await collectAll();
      console.log(`[scheduler] collect: inserted=${c.inserted} errors=${c.errors}`);
    } catch (err) {
      console.error("[scheduler] collect failed:", err);
    }
    if (hasLLM()) {
      try {
        const a = await runAnalysis();
        console.log(`[scheduler] analyze: analyzed=${a.analyzed} relevant=${a.relevant} errors=${a.errors}`);
      } catch (err) {
        console.error("[scheduler] analyze failed:", err);
      }
    } else {
      console.warn("[scheduler] no LLM configured — auto-analysis disabled (manual mode still works).");
    }
  };

  // Kick once on boot, then on the interval (collect then analyze new articles).
  void tick();
  setInterval(tick, intervalMin * 60_000);

  // Digest crons (KST): midday (digest only) + evening (digest + sweep + memo).
  const digestHour = Number(process.env.DIGEST_HOUR ?? 7);
  const midHour = middayHour();
  cron.schedule(`0 ${midHour} * * *`, () => void runMiddayRoutine(), { timezone: "Asia/Seoul" });
  cron.schedule(`0 ${digestHour} * * *`, () => void runEveningRoutine(), { timezone: "Asia/Seoul" });
  console.log(`[scheduler] digest crons at ${midHour}:00 (낮) and ${digestHour}:00 (저녁+정리) KST`);
  // Self-heal a run missed by a restart (e.g. today's deploy landed across the cron hour).
  void catchUpRoutines(digestHour);
}
