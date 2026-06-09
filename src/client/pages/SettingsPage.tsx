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
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold">분석 지침</h2>
        <p className="mt-1 mb-4 text-sm text-slate-500">
          여기에 쓴 내용이 곧 Claude의 시스템 프롬프트가 됩니다. 내가 추가한 소스에서 모인 글을
          이 지침대로 분석합니다. (관심 테마·보유 종목·논제·투자 스타일을 적어두면 그 기준으로 분석)
        </p>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">심층 분석 지침 (필수)</span>
          <textarea
            value={form.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            rows={12}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-700">
            1차 필터 기준 (선택 — 비우면 위 지침으로 판단)
          </span>
          <textarea
            value={form.relevanceCriteria ?? ""}
            onChange={(e) => set({ relevanceCriteria: e.target.value })}
            rows={3}
            placeholder="어떤 글을 '관련 있음'으로 볼지. 싼 모델이 먼저 걸러냅니다."
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">1차 필터 모델 (선택)</span>
            <input
              value={form.filterModel ?? ""}
              onChange={(e) => set({ filterModel: e.target.value || undefined })}
              placeholder="기본: FILTER_MODEL 환경변수"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">심층 분석 모델 (선택)</span>
            <input
              value={form.analysisModel ?? ""}
              onChange={(e) => set({ analysisModel: e.target.value || undefined })}
              placeholder="기본: ANALYSIS_MODEL 환경변수"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
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

      <p className="text-xs text-slate-400">
        자동 분석을 실행하려면 MySQL과 LLM이 연결돼 있어야 합니다 — <code>ANTHROPIC_API_KEY</code>
        (Claude) 또는 OpenAI 호환 엔드포인트(<code>LLM_BASE_URL</code> + <code>LLM_API_KEY</code>,
        예: Groq 무료). 키 없이도 <strong>분석(수동)</strong> 탭으로 분석할 수 있습니다. 정적 데모에서는
        지침이 이 브라우저에만 저장됩니다.
      </p>
    </div>
  );
}
