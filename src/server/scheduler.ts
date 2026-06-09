import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import { hasDb } from "./db/client.js";
import { hasAnthropic } from "./analysis/anthropic.js";

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
    if (hasAnthropic()) {
      try {
        const a = await runAnalysis();
        console.log(`[scheduler] analyze: analyzed=${a.analyzed} relevant=${a.relevant} errors=${a.errors}`);
      } catch (err) {
        console.error("[scheduler] analyze failed:", err);
      }
    } else {
      console.warn("[scheduler] ANTHROPIC_API_KEY not set — analysis disabled.");
    }
  };

  // Kick once on boot, then on the interval (collect then analyze new articles).
  void tick();
  setInterval(tick, intervalMin * 60_000);

  // Phase 4: digest cron at DIGEST_HOUR (KST).
}
