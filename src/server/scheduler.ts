import cron from "node-cron";
import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import { generateDigest } from "./digest/digest.js";
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
    () => {
      generateDigest()
        .then((r) => r && console.log(`[scheduler] digest: ${r.date} (${r.itemCount} items)`))
        .catch((err) => console.error("[scheduler] digest failed:", err));
    },
    { timezone: "Asia/Seoul" },
  );
  console.log(`[scheduler] digest cron at ${digestHour}:00 KST`);
}
