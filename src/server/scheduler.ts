import cron from "node-cron";
import { collectAll } from "./workers/collect.js";
import { runAnalysis } from "./analysis/analyze.js";
import {
  kstToday,
  kstHour,
  hasAutoDigestFor,
  hasMiddayFor,
  runMiddayDigest,
  runDailyDigests,
  middayHour,
  middayLabelDate,
  slotBounds,
} from "./digest/digest.js";
import { feedbackRepo } from "./repo/feedback.js";
import { eq } from "drizzle-orm";
import { db, hasDb } from "./db/client.js";
import { settings } from "./db/schema.js";
import { hasLLM } from "./analysis/anthropic.js";
import { getStoredSnapshot, refreshMarketSnapshot } from "./market/index.js";
import { collectResearch, researchLastCollectedAt } from "./research/index.js";

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

/**
 * 부팅 시 catch-up 재시도 가드 (settings KV, 마이그레이션 불필요).
 *
 * ⚠️ 왜 필요한가 — 2026-08 실제로 돈이 샌 경로:
 * catch-up은 "오늘 자동 다이제스트가 저장돼 있나"로 실행 여부를 정한다. 그런데
 * **생성이 실패하면 아무것도 저장되지 않으므로** 다음 부팅 때 또 "없다"고 판단한다.
 * push = 자동 재배포 = 부팅이라, 문제를 고치려고 배포할 때마다 실패한 다이제스트를
 * 통째로 다시 만들었다(하루 11회, 입력의 83%가 동일 프롬프트 재전송, 출력 91.7만 토큰).
 * 진짜로 놓친 크론은 살려야 하니 끄지는 않고, **날짜별 시도 횟수에 상한**을 둔다.
 */
const CATCHUP_KEY = "digestCatchUp";
const CATCHUP_MAX = 2; // 하루 슬롯당 최대 시도 횟수

interface CatchUpState {
  date: string;
  evening: number;
  midday: number;
}

async function catchUpState(): Promise<CatchUpState> {
  const today = kstToday();
  if (!hasDb) return { date: today, evening: 0, midday: 0 };
  const rows = await db.select().from(settings).where(eq(settings.key, CATCHUP_KEY)).limit(1);
  const v = rows[0]?.value as unknown as CatchUpState | undefined;
  return v && v.date === today ? v : { date: today, evening: 0, midday: 0 };
}

async function bumpCatchUp(slot: "evening" | "midday"): Promise<void> {
  if (!hasDb) return;
  const st = await catchUpState();
  const value = { ...st, [slot]: st[slot] + 1 } as unknown as Record<string, unknown>;
  await db.insert(settings).values({ key: CATCHUP_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
}

async function catchUpRoutines(digestHour: number): Promise<void> {
  try {
    const st = await catchUpState();
    // Boundary (HH:00) run for the window that closed this morning.
    if (kstHour() >= digestHour && !(await hasAutoDigestFor(kstToday(), "evening"))) {
      if (st.evening >= CATCHUP_MAX) {
        console.warn(
          `[scheduler] catch-up: ${digestHour}:00 boundary run은 오늘 이미 ${st.evening}회 시도해 건너뜁니다 ` +
            `— 계속 실패 중이라는 뜻이니 로그를 확인하고 수동 버튼으로 실행하세요.`,
        );
      } else {
        console.log(`[scheduler] catch-up: ${digestHour}:00 boundary run was missed — running now (시도 ${st.evening + 1}/${CATCHUP_MAX}).`);
        await bumpCatchUp("evening"); // 실행 **전에** 기록 — 실패해도 카운트가 올라가야 루프가 멈춘다
        await runEveningRoutine(); // backfills the midday분 too
      }
    }
    // 낮분 for the CURRENT window (label = its generation day), if its M시 has passed.
    const md = middayLabelDate();
    if (Date.now() >= slotBounds(md, "midday").end.getTime() && !(await hasMiddayFor(md))) {
      if (st.midday >= CATCHUP_MAX) {
        console.warn(`[scheduler] catch-up: midday run은 오늘 이미 ${st.midday}회 시도해 건너뜁니다.`);
      } else {
        console.log(`[scheduler] catch-up: midday run was missed — running now (시도 ${st.midday + 1}/${CATCHUP_MAX}).`);
        await bumpCatchUp("midday");
        await runMiddayRoutine();
      }
    }
  } catch (err) {
    console.error("[scheduler] catch-up failed:", err);
  }
}

/** 시황분석 daily batch: collect Fear&Greed + S5FI/NDFI + ADR once a day and
 *  store the snapshot. A single morning run (default 07시 KST) captures the US
 *  sources at their overnight end-of-day close and the Korean ADR at the prior
 *  session's close — every source at its freshest *settled* value. */
async function runMarketRoutine(): Promise<void> {
  try {
    const snap = await refreshMarketSnapshot();
    const ok = [snap.fearGreed && "F&G", snap.breadth.s5fi && "S5FI", snap.adr.kospi && "ADR"]
      .filter(Boolean)
      .join("+");
    console.log(`[scheduler] market snapshot: ${ok || "none"}${snap.errors.length ? ` (errors: ${snap.errors.length})` : ""}`);
  } catch (err) {
    console.error("[scheduler] market snapshot failed:", err);
  }
}

/** 리포트 daily batch: collect recent 증권사 리포트 from 한경 컨센서스 and upsert. */
async function runResearchRoutine(): Promise<void> {
  try {
    const r = await collectResearch();
    console.log(`[scheduler] research: inserted=${r.inserted}${r.error ? ` error="${r.error}"` : ""}`);
  } catch (err) {
    console.error("[scheduler] research collect failed:", err);
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

  // 시황분석 daily batch (KST). One run/day; refresh on boot if the stored
  // snapshot is missing or older than ~20h (covers a restart that skipped the cron).
  const marketHour = Number(process.env.MARKET_HOUR ?? 7);
  cron.schedule(`0 ${marketHour} * * *`, () => void runMarketRoutine(), { timezone: "Asia/Seoul" });
  console.log(`[scheduler] market snapshot cron at ${marketHour}:00 KST`);
  void (async () => {
    try {
      const snap = await getStoredSnapshot();
      const ageMs = snap ? Date.now() - new Date(snap.fetchedAt).getTime() : Infinity;
      const noHistory = !snap?.history || snap.history.fearGreed.length === 0;
      if (ageMs > 20 * 60 * 60_000 || noHistory) {
        console.log("[scheduler] market snapshot missing/stale/no-history on boot — collecting now.");
        await runMarketRoutine();
      }
    } catch (err) {
      console.error("[scheduler] market boot check failed:", err);
    }
  })();

  // 리포트 (증권사 리포트) daily batch (KST). Reports post pre-market; one morning
  // run + boot catch-up if stale (>12h). Intraday updates come via the 지금 수집 button.
  const researchHour = Number(process.env.RESEARCH_HOUR ?? 8);
  cron.schedule(`0 ${researchHour} * * *`, () => void runResearchRoutine(), { timezone: "Asia/Seoul" });
  console.log(`[scheduler] research reports cron at ${researchHour}:00 KST`);
  void (async () => {
    try {
      const last = await researchLastCollectedAt();
      const ageMs = last ? Date.now() - new Date(last).getTime() : Infinity;
      if (ageMs > 12 * 60 * 60_000) {
        console.log("[scheduler] research reports stale/missing on boot — collecting now.");
        await runResearchRoutine();
      }
    } catch (err) {
      console.error("[scheduler] research boot check failed:", err);
    }
  })();
}
