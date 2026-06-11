import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { AnalysisConfig } from "../data/client.js";

/**
 * Settings — edit the analysis instructions ("지침"). This text is used as the
 * system prompt that drives how each collected article is analyzed by Claude.
 */
export function SettingsPage() {
  const qc = useQueryClient();
  const cfgQuery = useQuery({
    queryKey: ["analysisConfig"],
    queryFn: () => api.getAnalysisConfig(),
  });
  const save = useMutation({
    mutationFn: (cfg: AnalysisConfig) => api.updateAnalysisConfig(cfg),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analysisConfig"] }),
  });

  const [form, setForm] = useState<AnalysisConfig | null>(null);
  useEffect(() => {
    if (cfgQuery.data && !form) setForm(cfgQuery.data);
  }, [cfgQuery.data, form]);

  if (!form) return <p className="text-slate-500">로딩…</p>;

  const set = (patch: Partial<AnalysisConfig>) => setForm({ ...form, ...patch });

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">분석 지침</h2>
          <p className="mt-1 text-sm text-slate-500">
            <strong>1차</strong>로 어떤 글을 뽑을지 거르고, <strong>2차</strong>로 그날 뽑힌 글들을
            <strong> 하루 한 번</strong> 종합 분석(다이제스트)합니다.
          </p>
        </div>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">
            1차 — 어떤 정보를 뽑을지 (필터)
          </span>
          <p className="text-xs text-slate-400">
            글마다 싼 모델이 이 기준으로 관련 여부를 판단합니다. 모든 글을 통과시키려면 “전부”라고 쓰세요.
          </p>
          <textarea
            value={form.relevanceCriteria ?? ""}
            onChange={(e) => set({ relevanceCriteria: e.target.value })}
            rows={6}
            placeholder="예: 반도체·AI 인프라·메모리/스토리지·광인터커넥트와 관련된 신호만. 단순 잡담/광고는 제외."
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">
            중요도 판별 — 낮은 중요도/개인적인 글 골라내기
          </span>
          <p className="text-xs text-slate-400">
            여기에 맞는 글은 Feed의 <strong>"검토 대상"</strong> 칸으로 따로 모입니다 (다이제스트 제외).
            훑어보고 남길지 지울지 결정하세요.
          </p>
          <textarea
            value={form.importanceCriteria ?? ""}
            onChange={(e) => set({ importanceCriteria: e.target.value })}
            rows={3}
            placeholder="예: 단순 잡담·인사·개인 일상·반복·광고는 낮음. 매매 판단·시황·실적·뉴스는 높음."
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">
            요약 지침 — 뽑힌 글을 Feed에 어떻게 요약할지
          </span>
          <p className="text-xs text-slate-400">
            1차에서 뽑힌 글마다 이 방식으로 요약해 Feed 카드에 보여줍니다. (판단과 별개 지침)
          </p>
          <textarea
            value={form.summaryInstructions ?? ""}
            onChange={(e) => set({ summaryInstructions: e.target.value })}
            rows={4}
            placeholder="예: 무엇을 발표/주장했는지 1~2문장 + 내 논지에 주는 함의 1문장."
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-700">
            2차 — 뽑힌 정보를 어떻게 종합 분석할지 (하루 1회 다이제스트)
          </span>
          <p className="text-xs text-slate-400">
            그날 1차로 뽑힌 글들을 한 번에 묶어, 서로 어떻게 연결되고 왜 중요한지 종합합니다. 결과 맨 아래엔
            뽑힌 글의 원문 링크가 자동으로 붙습니다.
          </p>
          <textarea
            value={form.digestInstructions ?? ""}
            onChange={(e) => set({ digestInstructions: e.target.value })}
            rows={14}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <details className="text-sm text-slate-600">
          <summary className="cursor-pointer font-medium">고급 (선택)</summary>
          <div className="mt-3 space-y-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                글별 개별 심층 분석 지침 — <code>DEEP_ANALYSIS=1</code>일 때만 사용
              </span>
              <textarea
                value={form.instructions}
                onChange={(e) => set({ instructions: e.target.value })}
                rows={6}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-700">1차 필터 모델 (선택)</span>
                <input
                  value={form.filterModel ?? ""}
                  onChange={(e) => set({ filterModel: e.target.value || undefined })}
                  placeholder="기본: FILTER_MODEL 환경변수"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">2차/심층 모델 (선택)</span>
                <input
                  value={form.analysisModel ?? ""}
                  onChange={(e) => set({ analysisModel: e.target.value || undefined })}
                  placeholder="기본: ANALYSIS_MODEL 환경변수"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
            </div>
          </div>
        </details>

        <div className="flex items-center gap-3">
          <button
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {save.isPending ? "저장 중…" : "지침 저장"}
          </button>
          {save.isSuccess && <span className="text-sm text-green-600">저장됨 ✓</span>}
          {save.error && (
            <span className="text-sm text-red-600">{(save.error as Error).message}</span>
          )}
        </div>
      </section>

      <FilterMemoSection />

      <p className="text-xs text-slate-400">
        자동 분석/다이제스트를 실행하려면 MySQL과 LLM이 연결돼 있어야 합니다 — <code>ANTHROPIC_API_KEY</code>
        (Claude) 또는 OpenAI 호환 엔드포인트(<code>LLM_BASE_URL</code> + <code>LLM_API_KEY</code>). 다이제스트는
        매일 <code>DIGEST_HOUR</code>(KST)에 생성됩니다.
      </p>
    </div>
  );
}

/**
 * Learned memo — auto-distilled from feed interactions (휴지통/남기기/복원). Separate
 * from importanceCriteria; injected into the 1st-pass filter's 중요/검토 judgment as a
 * reference (explicit criteria still wins). Updated daily at 21시; editable/clearable here.
 */
function FilterMemoSection() {
  const qc = useQueryClient();
  const memo = useQuery({ queryKey: ["filterGuidance"], queryFn: () => api.getFilterGuidance() });
  const save = useMutation({
    mutationFn: (text: string) => api.setFilterGuidance(text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["filterGuidance"] }),
  });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (memo.data && text === null) setText(memo.data.text);
  }, [memo.data, text]);
  if (text === null) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
      <div>
        <h2 className="text-lg font-semibold">학습 메모 (자동)</h2>
        <p className="mt-1 text-sm text-slate-500">
          내 상호작용(<strong>휴지통=중요↓ / 남기기·복원=중요↑</strong>)으로 자동 학습되는 메모입니다. 위의{" "}
          <strong>중요도 판별</strong> 기준과는 <strong>별개</strong>이며, 1차 필터의 중요/검토 판단에 참고용으로
          함께 쓰입니다(명시 기준이 우선). 매일 21시에 새 상호작용을 누적 통합합니다. 여기서 직접 고치거나 비울 수 있어요.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          누적 {memo.data?.count ?? 0}건
          {memo.data?.updatedAt
            ? ` · 갱신 ${new Date(memo.data.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`
            : ""}
        </p>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder="(아직 학습된 내용이 없습니다. 휴지통/남기기/복원으로 상호작용하면 21시에 채워집니다.)"
        className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate(text)}
          disabled={save.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {save.isPending ? "저장 중…" : "메모 저장"}
        </button>
        <button
          onClick={() => {
            setText("");
            save.mutate("");
          }}
          disabled={save.isPending}
          className="text-sm text-slate-400 hover:text-red-600"
        >
          비우기
        </button>
        {save.isSuccess && <span className="text-sm text-green-600">저장됨 ✓</span>}
        {save.error && <span className="text-sm text-red-600">{(save.error as Error).message}</span>}
      </div>
    </section>
  );
}
