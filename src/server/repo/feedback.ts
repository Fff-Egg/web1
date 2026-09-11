import { asc, eq, gt, inArray } from "drizzle-orm";
import { db, hasDb } from "../db/client.js";
import { filterFeedback, articles, analyses, sources } from "../db/schema.js";
import type { FeedbackAction } from "../db/schema.js";
import { settingsRepo } from "./settings.js";
import { complete, hasLLM, ANALYSIS_MODEL } from "../analysis/anthropic.js";

/** Overall cap on new rows scanned per daily distill (safety bound). */
const MAX_NEW = (): number => Number(process.env.FILTER_FEEDBACK_BATCH ?? 300);
/** Per-action-type cap for the LLM input (남기기 / 복원 / 휴지통 each). */
const PER_TYPE = (): number => Number(process.env.FILTER_FEEDBACK_PER_TYPE ?? 15);

type Signal = "positive" | "negative";

/**
 * Feedback log for tuning the 1st-pass filter's IMPORTANCE decision (중요 vs
 * 검토대상) — NOT the relevance gate (제외 여부 stays on relevanceCriteria).
 * Only USER actions write here (trash = 중요↓, promote = 중요↑); the system's
 * 21:00 feed sweep does not, so auto-cleanup never becomes a training signal.
 * Once a day the memo is updated CUMULATIVELY: new rows (id > cursor) are folded
 * into the existing memo, so past learning is preserved and compounds.
 */
export const feedbackRepo = {
  /** Snapshot the given articles' title/summary/source and append feedback rows. */
  async logArticles(ids: number[], signal: Signal, action: FeedbackAction): Promise<void> {
    if (!hasDb || ids.length === 0) return;
    try {
      const snaps = await db
        .select({
          id: articles.id,
          title: articles.title,
          summary: analyses.summary,
          source: sources.label,
        })
        .from(articles)
        .leftJoin(analyses, eq(analyses.articleId, articles.id))
        .leftJoin(sources, eq(articles.sourceId, sources.id))
        .where(inArray(articles.id, ids));
      if (snaps.length === 0) return;
      await db.insert(filterFeedback).values(
        snaps.map((s) => ({
          articleId: s.id,
          signal,
          action,
          title: s.title ?? null,
          summary: s.summary ?? null,
          source: s.source ?? null,
        })),
      );
    } catch (err) {
      console.error("[feedback] logArticles failed:", err instanceof Error ? err.message : err);
    }
  },

  /**
   * Fold NEW feedback (since the stored cursor) into the cumulative learned memo.
   * Runs once a day. The existing memo is carried forward and merged with the new
   * actions, so improvements accumulate rather than being rebuilt from one day.
   */
  async refreshGuidance(): Promise<{ updated: boolean; newCount: number; total: number }> {
    if (!hasDb) return { updated: false, newCount: 0, total: 0 };
    const prev = await settingsRepo.getFilterGuidance();
    const since = prev.lastFeedbackId ?? 0;
    const rows = await db
      .select({
        id: filterFeedback.id,
        action: filterFeedback.action,
        title: filterFeedback.title,
        summary: filterFeedback.summary,
      })
      .from(filterFeedback)
      .where(gt(filterFeedback.id, since))
      .orderBy(asc(filterFeedback.id))
      .limit(MAX_NEW());
    if (rows.length === 0) return { updated: false, newCount: 0, total: prev.count ?? 0 };
    const maxId = rows[rows.length - 1].id;
    const total = (prev.count ?? 0) + rows.length;

    // No LLM: just advance the cursor (keep prior memo) so rows aren't reprocessed.
    if (!hasLLM()) {
      await settingsRepo.setFilterGuidance({ ...prev, lastFeedbackId: maxId, count: total, updatedAt: new Date().toISOString() });
      return { updated: false, newCount: rows.length, total };
    }

    const fmt = (r: { title: string | null; summary: string | null }) =>
      `- ${(r.title ?? "").trim()}${r.summary ? ` · ${r.summary.trim().slice(0, 150)}` : ""}`;
    // Most-recent N of each action type (bounds & balances the daily LLM input).
    const per = PER_TYPE();
    const recent = (action: FeedbackAction) =>
      rows.filter((r) => r.action === action && (r.title ?? "").trim()).slice(-per);
    const promote = recent("promote"); // 검토→남기기 (중요↑)
    const restore = recent("restore"); // 휴지통→복원 (중요↑)
    const trash = recent("trash"); //    휴지통으로 (중요↓)

    const cfg = await settingsRepo.getAnalysisConfig();
    const model = cfg.analysisModel || ANALYSIS_MODEL();
    const system =
      "너는 개인 투자 피드의 '중요도 분류(중요 vs 검토대상)'를 다듬는 보조자다. 출력은 한국어로만. " +
      "이 메모는 글을 '중요(피드 노출)'로 볼지 '검토(낮음)'로 내릴지에만 쓰인다 — 관련성/제외 판단엔 쓰지 않는다. " +
      "아래 [기존 학습 메모]에 [새 사용자 행동]을 누적·통합한다. 기존 교훈은 유지하고(함부로 버리지 말 것), 새 신호와 충돌할 때만 조정한다. " +
      "출력은 갱신된 메모 '본문만'(머리말·해설 없이). 형식: '## 중요로 볼 경향'과 '## 검토(낮음)로 내릴 경향' 두 섹션, 각 항목 한 줄 불릿. 전체 14줄·600자 이내로 간결히.";
    const user =
      `[기존 학습 메모]\n${prev.text?.trim() || "(아직 없음)"}\n\n` +
      `[새 행동 — 남기기(중요로 올림)] ${promote.length}건\n${promote.map(fmt).join("\n") || "(없음)"}\n\n` +
      `[새 행동 — 복원(휴지통에서 되살림 = 중요로)] ${restore.length}건\n${restore.map(fmt).join("\n") || "(없음)"}\n\n` +
      `[새 행동 — 휴지통(중요에서 내림)] ${trash.length}건\n${trash.map(fmt).join("\n") || "(없음)"}\n\n` +
      `위를 누적 통합한 갱신 메모만 출력하라.`;

    let text = prev.text ?? "";
    try {
      const out = await complete({ model, system, user, maxTokens: 700, thinking: "disabled" });
      if (out.trim()) text = out.trim();
    } catch (err) {
      // Don't advance the cursor on failure — retry these rows next time.
      console.error("[feedback] guidance distill failed:", err instanceof Error ? err.message : err);
      return { updated: false, newCount: rows.length, total: prev.count ?? 0 };
    }
    await settingsRepo.setFilterGuidance({ text, lastFeedbackId: maxId, count: total, updatedAt: new Date().toISOString() });
    return { updated: true, newCount: rows.length, total };
  },
};
