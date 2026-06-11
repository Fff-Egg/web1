import cron from "node-cron";
import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import { generateDigest, kstToday, hasAutoDigestFor } from "./digest/digest.js";
import { feedbackRepo } from "./repo/feedback.js";
import { hasDb } from "./db/client.js";
import { hasLLM } from "./analysis/anthropic.js";

/** Current hour (0–23) in KST. */
function kstHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
}

/** Evening routine: fold the day's feedback into the filter memo, then generate
 *  the system auto-digest and sweep that window's non-saved feed picks to trash. */
async function runEveningRoutine(): Promise<void> {
  try {
    const fx = await feedbackRepo.refreshGuidance();
    console.log(`[scheduler] filter memo: ${fx.updated ? "updated" : "no change"} (new=${fx.newCount}, total=${fx.total})`);
  } catch (err) {
    console.error("[scheduler] filter memo refresh failed:", err);
  }
  try {
    const r = await generateDigest({ auto: true, trashFeedAfter: true });
    if (r) console.log(`[scheduler] digest: "${r.title}" (${r.itemCount} items)`);
  } catch (err) {
    console.error("[scheduler] digest failed:", err);
  }
}

/** node-cron can't replay a missed time; if today's evening run was skipped
 *  (e.g. a deploy restarted the server after DIGEST_HOUR), run it once on boot.
 *  Guarded so it never double-runs. */
async function catchUpEveningRoutine(digestHour: number): Promise<void> {
  try {
    if (kstHour() < digestHour) return; // today's window hasn't closed yet
    if (await hasAutoDigestFor(kstToday())) return; // already ran today
    console.log(`[scheduler] catch-up: today's ${digestHour}:00 run was missed — running now.`);
    await runEveningRoutine();
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

  // Evening digest cron at DIGEST_HOUR (KST).
  const digestHour = Number(process.env.DIGEST_HOUR ?? 21);
  cron.schedule(`0 ${digestHour} * * *`, () => void runEveningRoutine(), { timezone: "Asia/Seoul" });
  console.log(`[scheduler] digest cron at ${digestHour}:00 KST`);
  // Self-heal a 21시 run missed by a restart (e.g. today's deploy landed after 21시).
  void catchUpEveningRoutine(digestHour);
}
