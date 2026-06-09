import { collectAll } from "./workers/collect.js";

/**
 * Background schedulers. Phase 1 wires the collection loop. The analysis
 * pipeline (Phase 3) and the evening digest cron (Phase 4) hook in here.
 */
export function startSchedulers(): void {
  const intervalMin = Number(process.env.COLLECT_INTERVAL_MIN ?? 30);
  console.log(`[scheduler] collection every ${intervalMin}m`);

  const runCollect = async () => {
    try {
      const r = await collectAll();
      console.log(`[scheduler] collect: inserted=${r.inserted} errors=${r.errors}`);
    } catch (err) {
      console.error("[scheduler] collect failed:", err);
    }
  };

  // Kick once on boot, then on the interval.
  void runCollect();
  setInterval(runCollect, intervalMin * 60_000);

  // Phase 3: analysis pipeline tick (filter + deep analysis of new articles).
  // Phase 4: digest cron at DIGEST_HOUR (KST).
}
