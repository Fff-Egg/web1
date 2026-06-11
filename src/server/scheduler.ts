import cron from "node-cron";
import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import { generateDigest } from "./digest/digest.js";
import { feedbackRepo } from "./repo/feedback.js";
import { hasDb } from "./db/client.js";
import { hasLLM } from "./analysis/anthropic.js";

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

  // Evening digest cron at DIGEST_HOUR (KST).
  const digestHour = Number(process.env.DIGEST_HOUR ?? 21);
  cron.schedule(
    `0 ${digestHour} * * *`,
    async () => {
      // 1) Fold the day's interactions into the cumulative filter memo — BEFORE the
      //    feed sweep, so the sweep never affects the learning signal.
      try {
        const fx = await feedbackRepo.refreshGuidance();
        console.log(`[scheduler] filter memo: ${fx.updated ? "updated" : "no change"} (new=${fx.newCount}, total=${fx.total})`);
      } catch (err) {
        console.error("[scheduler] filter memo refresh failed:", err);
      }
      // 2) System auto-digest of the day that just closed (window [(today-1) HH, today HH)),
      //    then sweep that window's non-saved feed picks to trash.
      try {
        const r = await generateDigest({ auto: true, trashFeedAfter: true });
        if (r) console.log(`[scheduler] digest: "${r.title}" (${r.itemCount} items)`);
      } catch (err) {
        console.error("[scheduler] digest failed:", err);
      }
    },
    { timezone: "Asia/Seoul" },
  );
  console.log(`[scheduler] digest cron at ${digestHour}:00 KST`);
}
