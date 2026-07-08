import { useMemo } from "react";
import type { MarketSnapshot } from "../data/client.js";
import { computeCapitulation, CAP_LEVELS } from "./capitulation.js";

/** 공포 강도(0 관망 → 3 심각) 색상 — O/X와 별개로 기준 대비 깊이를 한눈에. */
const LEVEL_CLS = [
  "bg-slate-100 text-slate-400",
  "bg-amber-100 text-amber-700",
  "bg-orange-100 text-orange-700",
  "bg-red-100 text-red-700",
];

/**
 * 캐피출레이션 바닥 감지 — 시황분석 맨 아래. 4개 경험칙 신호(신용잔고 급감 /
 * 반대매매 스파이크 피크아웃 / VKOSPI 상위5% 후 꺾임 / 60일 이격도 과매도)를
 * O/X로 판정하고, 3/4 이상 충족 시 "분할 예비대"를 안내. 매수 신호가 아니라
 * 관찰 도구임을 명시한다.
 */
export function CapitulationPanel({ data }: { data: MarketSnapshot }) {
  const cap = useMemo(() => computeCapitulation(data), [data]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">
          캐피출레이션(투매) 바닥 감지 <span className="text-xs font-normal text-slate-400">국내 지수 · 4신호</span>
        </h3>
        <span
          className={
            "rounded-full px-2.5 py-0.5 text-xs font-semibold " +
            (cap.triggered ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500")
          }
        >
          {cap.total === 0 ? "데이터 수집 전" : `${cap.met}/${cap.total} 충족`}
          {cap.triggered ? " · 분할 예비대 고려" : ""}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-slate-100">
        {cap.signals.map((s) => (
          <li key={s.key} className="flex items-start gap-3 py-2">
            <span
              className={
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold " +
                (!s.hasData
                  ? "bg-slate-100 text-slate-300"
                  : s.met
                    ? "bg-red-500 text-white"
                    : "bg-slate-100 text-slate-400")
              }
            >
              {!s.hasData ? "–" : s.met ? "O" : "X"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-700">{s.key}</span>
                  {s.hasData && (
                    <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold " + LEVEL_CLS[s.level]}>
                      {CAP_LEVELS[s.level]}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">{s.value}</span>
              </div>
              {s.criteria && <div className="text-[11px] text-slate-400">조건: {s.criteria}</div>}
              <div className="text-xs text-slate-500">{s.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-500">
        ⚠️ 백테스트된 시스템이 아니라 개별 경험칙을 보수적으로 묶은 <strong>관찰 도구</strong>입니다. 진짜 투매 바닥은
        10년에 4~6번뿐이라 통계 검증 불가 — <strong>3/4 이상일 때 예비대 1차(예: 1/3)</strong>, 이후 신용잔고
        −15%/−20%에서 2·3차 분할이 이 설계의 오류 허용치입니다. 매수 확정 신호 아님.
      </p>
    </div>
  );
}
