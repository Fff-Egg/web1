import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { AnalysisConfig, ModelPlan } from "../data/client.js";

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
  const planQuery = useQuery({
    queryKey: ["modelPlan"],
    queryFn: () => api.getModelPlan(),
  });
  const save = useMutation({
    mutationFn: (cfg: AnalysisConfig) => api.updateAnalysisConfig(cfg),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["analysisConfig"] }),
        qc.invalidateQueries({ queryKey: ["modelPlan"] }),
      ]);
    },
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
            <strong>Flash</strong>가 글을 넓게 선별·정리하고, <strong>Pro</strong>가 여러 글의 연결과 함의를
            최종 다이제스트로 종합하도록 단계별 모델을 나눌 수 있습니다.
          </p>
          <p className="mt-2 rounded border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            논지 지도는 글을 거르는 필터가 아니라 선별 후 붙이는 사후 태그입니다. 바이오·방산·크립토 등 현재
            논지 밖의 신호도 같은 기준으로 수집됩니다.
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
            placeholder="예: 투자·경제·산업·정책에 직간접 영향이 있으면 보존. 섹터 제한 없음. 순수 잡담·광고만 제외."
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
            placeholder="예: 수요·공급·가격·정책·수급·병목을 바꿀 수 있으면 높음. 정보 없는 잡담·광고만 낮음."
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
            placeholder="예: 관측 사실 1~2문장 + 가능한 2차 파급(가설) + 확인할 데이터. 기존 논지에 억지로 연결하지 않음."
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
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-700">1차 글 선별 모델</span>
                <span className="mt-0.5 block text-[11px] text-slate-400">Flash 권장 · 비우면 FILTER_MODEL</span>
                <input
                  value={form.filterModel ?? ""}
                  onChange={(e) => set({ filterModel: e.target.value || undefined })}
                  placeholder="기본: FILTER_MODEL 환경변수"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">다이제스트 자료 정리 모델</span>
                <span className="mt-0.5 block text-[11px] text-slate-400">Flash 권장 · 비우면 1차 모델</span>
                <input
                  value={form.digestMapModel ?? ""}
                  onChange={(e) => set({ digestMapModel: e.target.value || undefined })}
                  placeholder="기본: 1차 글 선별 모델"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">최종 연결·심층 모델</span>
                <span className="mt-0.5 block text-[11px] text-slate-400">Pro 권장 · 비우면 ANALYSIS_MODEL</span>
                <input
                  value={form.analysisModel ?? ""}
                  onChange={(e) => set({ analysisModel: e.target.value || undefined })}
                  placeholder="기본: ANALYSIS_MODEL 환경변수"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
            </div>
            {planQuery.data && <ModelFlowCard plan={planQuery.data} />}
            {planQuery.error && (
              <p className="text-xs text-red-600">현재 적용 모델을 불러오지 못했습니다.</p>
            )}
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

function sourceLabel(source: ModelPlan["filter"]["source"]): string {
  if (source === "web") return "웹 설정";
  if (source === "railway") return "Railway 변수";
  if (source === "filter") return "1차 모델 상속";
  return "기본값";
}

function ModelFlowCard({ plan }: { plan: ModelPlan }) {
  const steps = [
    { label: "① 글별 선별", step: plan.filter },
    { label: "② 묶음별 사실 정리", step: plan.map },
    { label: "③ 최종 연결·작성", step: plan.final },
  ];
  const remapped = steps.filter(({ step }) => step.configured !== step.effective);
  const separated = plan.map.effective !== plan.final.effective;
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-indigo-900">현재 서버 적용 흐름</p>
        <span className="rounded bg-white/80 px-2 py-0.5 text-[10px] text-indigo-600">
          {plan.provider === "openai-compatible"
            ? "OpenAI 호환 API"
            : plan.provider === "anthropic"
              ? "Anthropic API"
              : "LLM 미설정"}
        </span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {steps.map(({ label, step }, index) => (
          <div key={label} className="relative rounded-md border border-indigo-100 bg-white px-3 py-2">
            <p className="text-[10px] font-medium text-slate-500">{label}</p>
            <p className="mt-0.5 break-all font-mono text-xs font-semibold text-slate-800">{step.effective}</p>
            <p className="mt-1 text-[10px] text-slate-400">{sourceLabel(step.source)}</p>
            {index < steps.length - 1 && (
              <span className="absolute -right-2.5 top-1/2 z-10 hidden -translate-y-1/2 text-indigo-300 sm:block">→</span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-indigo-800">
        최종 모델은 최대 {plan.finalTokens.toLocaleString()}토큰으로 <strong>{plan.finalAttempts}번만</strong> 실행합니다. 실패하면
        같은 모델을 재시도하지 않고 원인을 기록한 뒤, 자료 정리 모델을 최대
        {plan.finalFallbackTokens.toLocaleString()}토큰으로 즉시 실행합니다.
      </p>
      {remapped.map(({ label, step }) => (
        <p key={label} className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          ⚠ {label}: 설정값 <span className="font-mono">{step.configured}</span>은 현재 API에서 실제로{
          " "}<span className="font-mono font-semibold">{step.effective}</span>(으)로 치환됩니다.
        </p>
      ))}
      {!separated && (
        <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          ⚠ 자료 정리와 최종 종합이 같은 모델입니다. Flash→Pro 분리를 원하면 서로 다른 모델을 지정하세요.
        </p>
      )}
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
