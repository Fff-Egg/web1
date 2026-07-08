import { useMemo } from "react";
import type { MarketSnapshot } from "../data/client.js";
import { computeKFear, GRADE_LABEL, KOSDAQ_ONLY_CAP, type Grade, type MarketFear } from "./kfear.js";
import { InteractiveLineChart } from "./InteractiveLineChart.js";

/**
 * K-공포지수 대시보드 — 시황분석 맨 아래. 코스피/코스닥 각각 0~100 공포지수(FEAR)
 * + 3신호(S1 신용/S2 반대매매/S3 이격도) + 등급/사이징을 계산해 "오늘 매수 국면인지
 * + 진입 몇 차인지"를 보여준다. 검증된 레퍼런스(kfear.ts) 로직을 그대로 쓴다.
 * ⚠️ 소표본(n=6~16) 백테스트 기반 관찰 도구이며 투자 권유가 아니다.
 */
const LEVEL_LABEL = ["관망", "경계", "공포", "심각"];
const LEVEL_CLS = [
  "bg-slate-100 text-slate-400",
  "bg-amber-100 text-amber-700",
  "bg-orange-100 text-orange-700",
  "bg-red-100 text-red-700",
];
const GRADE_CLS: Record<Grade, string> = {
  STRONG: "bg-red-700 text-white",
  BUY: "bg-red-500 text-white",
  ARMED: "bg-orange-500 text-white",
  WATCH: "bg-amber-300 text-amber-900",
  IDLE: "bg-slate-200 text-slate-500",
};

/** FEAR 밴드 색 (문서 5-3): <65 회색 / 65–80 노랑 / 80–90 주황 / 90+ 빨강. */
function fearColor(f: number | null): { bar: string; text: string } {
  if (f === null) return { bar: "bg-slate-300", text: "text-slate-400" };
  if (f >= 90) return { bar: "bg-red-500", text: "text-red-600" };
  if (f >= 80) return { bar: "bg-orange-500", text: "text-orange-600" };
  if (f >= 65) return { bar: "bg-amber-400", text: "text-amber-600" };
  return { bar: "bg-slate-400", text: "text-slate-500" };
}

function fmtDate(t: number | null): string {
  if (t === null) return "—";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function MarketCard({ m }: { m: MarketFear }) {
  const c = fearColor(m.fear);
  const fearPct = m.fear === null ? 0 : Math.max(0, Math.min(100, m.fear));
  const showRegimeWarn = m.market === "코스닥" && m.signaling && m.regime === "KOSDAQ_ONLY";
  const showRegimeOk = m.market === "코스닥" && m.signaling && m.regime === "SYSTEMIC";

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-700">{m.market}</span>
        <span className={"rounded px-2 py-0.5 text-xs font-bold " + GRADE_CLS[m.grade]}>
          {m.grade} {GRADE_LABEL[m.grade]}
        </span>
      </div>

      {/* FEAR 게이지 */}
      <div className="mt-2 flex items-end gap-2">
        <span className={"text-3xl font-bold tabular-nums " + c.text}>{m.fear === null ? "—" : m.fear.toFixed(1)}</span>
        <span className="pb-1 text-xs text-slate-400">/ 100 공포지수</span>
      </div>
      <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={"h-full rounded-full " + c.bar} style={{ width: `${fearPct}%` }} />
        {/* 90 매수 임계선 */}
        <div className="absolute top-0 h-full w-px bg-slate-500/60" style={{ left: "90%" }} />
      </div>
      {/* 최종 권장 비중 = depth × 등급계수 (코스닥 단독이면 상한). */}
      <div className="mt-2 rounded-md bg-slate-50 px-2.5 py-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-slate-500">권장 비중</span>
          <span className="text-2xl font-bold tabular-nums text-slate-800">
            {m.sizing.pct}%
            {m.sizing.capped && <span className="ml-1 align-middle text-[10px] font-semibold text-amber-600">단독 상한</span>}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400">
          <span>
            depth <span className="font-medium text-slate-500">{m.sizing.base}%</span> × 등급 {m.grade}{" "}
            <span className="font-medium text-slate-500">{m.sizing.coef.toFixed(2)}</span>
            {m.regime === "KOSDAQ_ONLY" && ` → 코스닥 단독 ${KOSDAQ_ONLY_CAP}% 상한`}
          </span>
          <span>{m.nOn}/3 신호</span>
        </div>
      </div>
      {/* 사이징 사다리 — 신용 낙폭(depth)이 깊을수록 큰 분할. 도달한 단계 강조. */}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] tabular-nums">
        <span className="text-slate-400">depth 사다리 (신용 {m.creditDd !== null ? `${(m.creditDd * 100).toFixed(1)}%` : "—"}) →</span>
        {[
          { label: "1차", th: -8, alloc: "40%" },
          { label: "2차", th: -15, alloc: "70%" },
          { label: "3차", th: -25, alloc: "100%" },
        ].map((t) => {
          const reached = m.creditDd !== null && m.creditDd * 100 <= t.th;
          return (
            <span
              key={t.label}
              className={"rounded px-1.5 py-0.5 " + (reached ? "bg-red-100 font-semibold text-red-700" : "bg-slate-100 text-slate-400")}
            >
              {t.label} ≤{t.th}% <span className="font-normal opacity-70">≈{t.alloc}</span>
            </span>
          );
        })}
        {(m.creditDd === null || m.creditDd * 100 > -8) && <span className="text-slate-400">· 미도달=20%</span>}
      </div>

      {showRegimeWarn && (
        <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
          ⚠️ 코스피 미동반 — 코스닥 단독 약세 가능성(과거 이 조합의 6개월 기대수익 낮음)
        </div>
      )}
      {showRegimeOk && (
        <div className="mt-2 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
          ✓ 시장 전반 공포(코스피 동반) — 과거 이 조합의 신뢰 높음
        </div>
      )}

      {/* 3신호 */}
      <ul className="mt-2 divide-y divide-slate-100">
        {m.signals.map((s) => (
          <li key={s.key} className="flex items-start gap-2 py-1.5">
            <span
              className={
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " +
                (s.met ? "bg-red-500 text-white" : "bg-slate-100 text-slate-400")
              }
            >
              {s.met ? "O" : "X"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-700">{s.key}</span>
                  <span className={"shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold " + LEVEL_CLS[s.level]}>
                    {LEVEL_LABEL[s.level]}
                  </span>
                </div>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-800">{s.value}</span>
              </div>
              <div className="text-[10px] text-slate-400">조건: {s.criteria}</div>
              <div className="text-[11px] text-slate-500">{s.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      {/* FEAR 추이 + 90 임계선 */}
      {m.fearHistory.length > 1 && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-400">FEAR 추이 (90 = 매수 임계)</div>
          <InteractiveLineChart
            series={[{ points: m.fearHistory, color: c.bar.includes("red") ? "#ef4444" : "#0d9488", label: "FEAR" }]}
            baselines={[90]}
            decimals={0}
            height={110}
          />
        </div>
      )}
    </div>
  );
}

export function KFearPanel({ data }: { data: MarketSnapshot }) {
  const kf = useMemo(() => computeKFear(data), [data]);
  const { kospi, kosdaq } = kf;

  const asOf = kospi.asOf ?? kosdaq.asOf;
  // 기준일(=KOFIA/지수 최신일)이 수집시각보다 한참 뒤면 소스가 멈춘 것(주말·T+1 감안 6일↑).
  const staleDays = asOf ? Math.floor((Date.parse(data.fetchedAt) - asOf) / 86400000) : 0;
  const active = [kospi, kosdaq].filter((m) => m.grade === "STRONG" || m.grade === "BUY");
  const headline =
    !kospi.hasData && !kosdaq.hasData
      ? "데이터 수집 전 — '지금 갱신'을 눌러 수집하세요"
      : active.length > 0
        ? `${active.map((m) => `${m.market} ${GRADE_LABEL[m.grade]}(${m.grade}) · 비중 ${m.sizing.pct}%`).join(" / ")}${
            kosdaq.signaling && kosdaq.regime === "KOSDAQ_ONLY" ? " · ⚠️코스피 미동반" : ""
          }`
        : "오늘 특이 공포 신호 없음 (양시장 대기/관찰)";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">
          K-공포지수 · 캐피출레이션 바닥 <span className="text-xs font-normal text-slate-400">코스피·코스닥 · FEAR(0~100)+3신호</span>
        </h3>
        <span className="text-xs text-slate-400">
          기준일 {fmtDate(asOf)}
          {staleDays > 6 && <span className="ml-1 font-medium text-amber-600">· ⚠️ {staleDays}일 지연(소스 확인)</span>}
        </span>
      </div>

      <div
        className={
          "mb-3 rounded px-3 py-2 text-sm font-medium " +
          (active.length > 0 ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600")
        }
      >
        오늘: {headline}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MarketCard m={kospi} />
        <MarketCard m={kosdaq} />
      </div>

      <div className="mt-3 rounded bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        <strong>권장 비중 = depth × 등급계수</strong> (코스닥 단독이면 상한).{" "}
        <span className="text-slate-500">depth(신용 DD): −8%=40 · −15%=70 · −25%=100 · else 20. </span>
        등급계수: <strong>STRONG 1.0 · BUY 0.75 · ARMED 0.65 · WATCH 0.45 · IDLE 0</strong>.{" "}
        코스닥 <strong>단독(코스피 미동반)</strong>은 계수 대신 <strong>{KOSDAQ_ONLY_CAP}% 상한</strong>(6달 승률 50% 반반).
        <span className="mt-1 block text-slate-500">
          ※ 백테스트(2020~ 통합 n=10~31) 기준 — <strong className="text-slate-600">방향성(STRONG&gt;BUY&gt;ARMED&gt;WATCH)만 신뢰</strong>,
          계수 소수점은 노이즈. 어느 등급이든 6개월 기대 +11~20%였음(다 플러스).
        </span>
      </div>
      <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-500">
        ⚠️ 이 지표는 <strong>소표본 백테스트</strong> 기반이며 <strong>투자 권유가 아닙니다</strong>. 모든 판단과 결과는
        사용자 책임입니다. FEAR·신호는 완전 워밍업(~311거래일) 이후만 신뢰하세요(차트는 그 이후만 표시).
      </p>
    </div>
  );
}
