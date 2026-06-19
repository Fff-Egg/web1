import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { threads, signals, articles, sources, analyses } from "../db/schema.js";
import { VERDICTS, TIERS } from "../db/schema.js";
import type { Verdict, Tier } from "../db/schema.js";

/** Minimal thread shape injected into the 1st-pass analysis prompt. */
export interface ThreadBrief {
  id: number;
  code: string | null;
  name: string;
  thesis: string | null;
}

/** A thread plus system-aggregated signal stats (NOT LLM confidence). */
export interface ThreadWithStats {
  id: number;
  code: string | null;
  name: string;
  thesis: string | null;
  context: string | null;
  archived: boolean;
  sort: number;
  createdAt: string | Date;
  total: number;
  lastSignalAt: string | Date | null;
  /** verdict counts in the last 7 / 30 days */
  c7: Record<Verdict, number>;
  c30: Record<Verdict, number>;
}

/** A signal row joined with its article (for thread detail & inbox). */
export interface SignalRow {
  id: number;
  articleId: number;
  threadId: number | null;
  candidate: string | null;
  verdict: Verdict;
  tier: Tier;
  note: string | null;
  createdAt: string | Date;
  title: string | null;
  url: string | null;
  provider: string | null;
  sourceLabel: string | null;
  summary: string | null;
}

/** What the analyzer extracts for one article (loose; normalized on the way in). */
export interface ExtractedSignal {
  threadId?: number | null;
  threadCode?: string | null;
  verdict?: string | null;
  tier?: string | null;
  note?: string | null;
}
export interface NewThreadProposal {
  name?: string | null;
  thesis?: string | null;
  verdict?: string | null;
  tier?: string | null;
  note?: string | null;
}
export interface ExtractedThesis {
  signals?: ExtractedSignal[];
  newThread?: NewThreadProposal | null;
}

const ko2verdict: Record<string, Verdict> = {
  강화: "support", 지지: "support", support: "support",
  약화: "weaken", weaken: "weaken",
  반증: "refute", refute: "refute",
  중립: "neutral", neutral: "neutral",
};
const ko2tier: Record<string, Tier> = {
  확정: "confirmed", 사실: "confirmed", confirmed: "confirmed",
  경영진주장: "mgmt", 경영진: "mgmt", 주장: "mgmt", mgmt: "mgmt",
  추론: "inference", inference: "inference",
  추측: "speculation", speculation: "speculation",
};

function normVerdict(s?: string | null): Verdict | null {
  if (!s) return null;
  const k = s.trim().toLowerCase();
  if ((VERDICTS as readonly string[]).includes(k)) return k as Verdict;
  return ko2verdict[s.trim()] ?? null;
}
function normTier(s?: string | null): Tier {
  if (!s) return "inference";
  const k = s.trim().toLowerCase();
  if ((TIERS as readonly string[]).includes(k)) return k as Tier;
  return ko2tier[s.trim()] ?? "inference";
}

const DAY = 24 * 60 * 60 * 1000;

export const thesisRepo = {
  /** Active threads (brief) for injecting into the analysis prompt. */
  async listBrief(): Promise<ThreadBrief[]> {
    if (!hasDb) return [];
    return db
      .select({ id: threads.id, code: threads.code, name: threads.name, thesis: threads.thesis })
      .from(threads)
      .where(eq(threads.archived, false))
      .orderBy(asc(threads.sort), asc(threads.code), asc(threads.name));
  },

  /** Threads with aggregated signal stats (7/30-day verdict counts, last signal). */
  async listWithStats(includeArchived = false): Promise<ThreadWithStats[]> {
    if (!hasDb) return [];
    const d7 = new Date(Date.now() - 7 * DAY);
    const d30 = new Date(Date.now() - 30 * DAY);
    const cnt = (v: Verdict, since: Date) =>
      sql<number>`SUM(CASE WHEN ${signals.verdict} = ${v} AND ${signals.createdAt} >= ${since} THEN 1 ELSE 0 END)`;
    const rows = await db
      .select({
        id: threads.id,
        code: threads.code,
        name: threads.name,
        thesis: threads.thesis,
        context: threads.context,
        archived: threads.archived,
        sort: threads.sort,
        createdAt: threads.createdAt,
        total: sql<number>`SUM(CASE WHEN ${signals.id} IS NOT NULL THEN 1 ELSE 0 END)`,
        lastSignalAt: sql<string | Date | null>`MAX(${signals.createdAt})`,
        s7: cnt("support", d7), w7: cnt("weaken", d7), r7: cnt("refute", d7), n7: cnt("neutral", d7),
        s30: cnt("support", d30), w30: cnt("weaken", d30), r30: cnt("refute", d30), n30: cnt("neutral", d30),
      })
      .from(threads)
      .leftJoin(signals, eq(signals.threadId, threads.id))
      .where(includeArchived ? undefined : eq(threads.archived, false))
      .groupBy(
        threads.id, threads.code, threads.name, threads.thesis,
        threads.context, threads.archived, threads.sort, threads.createdAt,
      )
      .orderBy(asc(threads.sort), asc(threads.code), asc(threads.name));
    return rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, thesis: r.thesis, context: r.context,
      archived: !!r.archived, sort: Number(r.sort), createdAt: r.createdAt,
      total: Number(r.total ?? 0),
      lastSignalAt: r.lastSignalAt ?? null,
      c7: { support: Number(r.s7 ?? 0), weaken: Number(r.w7 ?? 0), refute: Number(r.r7 ?? 0), neutral: Number(r.n7 ?? 0) },
      c30: { support: Number(r.s30 ?? 0), weaken: Number(r.w30 ?? 0), refute: Number(r.r30 ?? 0), neutral: Number(r.n30 ?? 0) },
    }));
  },

  async createThread(input: { code?: string | null; name: string; thesis?: string | null; context?: string | null }): Promise<{ id: number }> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    const [res] = await db.insert(threads).values({
      code: input.code ?? null,
      name: input.name,
      thesis: input.thesis ?? null,
      context: input.context ?? null,
    });
    return { id: Number(res.insertId) };
  },

  async updateThread(input: { id: number; code?: string | null; name?: string; thesis?: string | null; context?: string | null; sort?: number }): Promise<void> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    const patch: Record<string, unknown> = {};
    if (input.code !== undefined) patch.code = input.code;
    if (input.name !== undefined) patch.name = input.name;
    if (input.thesis !== undefined) patch.thesis = input.thesis;
    if (input.context !== undefined) patch.context = input.context;
    if (input.sort !== undefined) patch.sort = input.sort;
    if (Object.keys(patch).length === 0) return;
    await db.update(threads).set(patch).where(eq(threads.id, input.id));
  },

  async setArchived(id: number, archived: boolean): Promise<void> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    await db.update(threads).set({ archived }).where(eq(threads.id, id));
  },

  /** Hard-delete a thread (and its signals via FK cascade). */
  async removeThread(id: number): Promise<void> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    await db.delete(threads).where(eq(threads.id, id));
  },

  /** Signals attached to one thread, newest first, with article info. */
  async threadSignals(threadId: number, limit = 200): Promise<SignalRow[]> {
    if (!hasDb) return [];
    return db
      .select(signalSelect)
      .from(signals)
      .innerJoin(articles, eq(signals.articleId, articles.id))
      .leftJoin(sources, eq(articles.sourceId, sources.id))
      .leftJoin(analyses, eq(analyses.articleId, articles.id))
      .where(eq(signals.threadId, threadId))
      .orderBy(desc(signals.createdAt))
      .limit(limit) as Promise<SignalRow[]>;
  },

  /** Inbox — unassigned "new thesis candidate" signals (threadId IS NULL). */
  async inbox(limit = 200): Promise<SignalRow[]> {
    if (!hasDb) return [];
    return db
      .select(signalSelect)
      .from(signals)
      .innerJoin(articles, eq(signals.articleId, articles.id))
      .leftJoin(sources, eq(articles.sourceId, sources.id))
      .leftJoin(analyses, eq(analyses.articleId, articles.id))
      .where(isNull(signals.threadId))
      .orderBy(desc(signals.createdAt))
      .limit(limit) as Promise<SignalRow[]>;
  },

  /** Attach an inbox candidate to an existing thread. */
  async assignSignal(signalId: number, threadId: number): Promise<void> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    try {
      await db.update(signals).set({ threadId, candidate: null }).where(eq(signals.id, signalId));
    } catch {
      // unique(article, thread) clash — the article already scores this thread; drop the dup.
      await db.delete(signals).where(eq(signals.id, signalId));
    }
  },

  /** Promote an inbox candidate into a brand-new thread. */
  async promoteSignal(signalId: number, override?: { name?: string; thesis?: string }): Promise<{ threadId: number }> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    const [row] = await db.select().from(signals).where(eq(signals.id, signalId)).limit(1);
    if (!row) throw new Error("signal not found");
    const name = (override?.name ?? row.candidate ?? "새 논지").trim() || "새 논지";
    const { id } = await this.createThread({ name, thesis: override?.thesis ?? null });
    await db.update(signals).set({ threadId: id, candidate: null }).where(eq(signals.id, signalId));
    return { threadId: id };
  },

  /** Discard a signal (e.g. an inbox candidate that's noise). */
  async dismissSignal(signalId: number): Promise<void> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    await db.delete(signals).where(eq(signals.id, signalId));
  },

  /**
   * Persist the signals the analyzer extracted for one (relevant) article.
   * `threadList` is the active-thread set the prompt was built from — used to
   * resolve threadCode → id. No-op when there's nothing to store.
   */
  async storeSignals(articleId: number, extracted: ExtractedThesis, threadList: ThreadBrief[]): Promise<void> {
    if (!hasDb) return;
    const byId = new Map(threadList.map((t) => [t.id, t]));
    const byCode = new Map(threadList.filter((t) => t.code).map((t) => [t.code!.trim().toUpperCase(), t]));
    const rows: { threadId: number | null; candidate: string | null; verdict: Verdict; tier: Tier; note: string | null }[] = [];

    for (const s of extracted.signals ?? []) {
      const verdict = normVerdict(s.verdict);
      if (!verdict) continue;
      let threadId: number | null = null;
      if (s.threadId != null && byId.has(Number(s.threadId))) threadId = Number(s.threadId);
      else if (s.threadCode && byCode.has(s.threadCode.trim().toUpperCase()))
        threadId = byCode.get(s.threadCode.trim().toUpperCase())!.id;
      if (threadId == null) continue; // unknown thread reference — skip (newThread covers genuinely new ones)
      rows.push({ threadId, candidate: null, verdict, tier: normTier(s.tier), note: s.note?.trim() || null });
    }

    const nt = extracted.newThread;
    if (nt && nt.name && nt.name.trim()) {
      const verdict = normVerdict(nt.verdict) ?? "support";
      rows.push({ threadId: null, candidate: nt.name.trim().slice(0, 255), verdict, tier: normTier(nt.tier), note: nt.note?.trim() || null });
    }

    for (const r of rows) {
      try {
        if (r.threadId != null) {
          await db
            .insert(signals)
            .values({ articleId, threadId: r.threadId, verdict: r.verdict, tier: r.tier, note: r.note })
            .onDuplicateKeyUpdate({ set: { verdict: r.verdict, tier: r.tier, note: r.note } });
        } else {
          await db.insert(signals).values({
            articleId, threadId: null, candidate: r.candidate, verdict: r.verdict, tier: r.tier, note: r.note,
          });
        }
      } catch (err) {
        console.error("[thesis] storeSignals row failed:", err instanceof Error ? err.message : err);
      }
    }
  },

  /** Seed the user's A~E starter threads (only if none exist yet). */
  async seedDefaults(): Promise<{ created: number }> {
    if (!hasDb) throw new Error("DATABASE_URL required");
    const [{ n }] = await db.select({ n: sql<number>`COUNT(*)` }).from(threads);
    if (Number(n) > 0) return { created: 0 };
    const seed = [
      { code: "A", name: "NAND / HBF", thesis: "NAND 업황 반등과 HBF(고대역폭 플래시) 구조적 수요" },
      { code: "B", name: "HBM / DRAM", thesis: "HBM·DRAM 사이클과 AI 메모리 수요 확대" },
      { code: "C", name: "광인터커넥트", thesis: "데이터센터 광인터커넥트(실리콘 포토닉스) 채택 가속" },
      { code: "D", name: "ALAB (Astera Labs)", thesis: "커넥티비티 반도체(Astera Labs) 성장" },
      { code: "E", name: "로보틱스", thesis: "휴머노이드·로보틱스 상용화 진전" },
    ];
    await db.insert(threads).values(seed.map((s, i) => ({ ...s, sort: i })));
    return { created: seed.length };
  },
};

const signalSelect = {
  id: signals.id,
  articleId: signals.articleId,
  threadId: signals.threadId,
  candidate: signals.candidate,
  verdict: signals.verdict,
  tier: signals.tier,
  note: signals.note,
  createdAt: signals.createdAt,
  title: articles.title,
  url: articles.url,
  provider: sources.provider,
  sourceLabel: sources.label,
  summary: analyses.summary,
};
