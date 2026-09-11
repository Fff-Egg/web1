import { useMemo } from "react";
import type { MarketSnapshot } from "../data/client.js";
import { computeKFear, GRADE_LABEL, type Grade, type MarketFear } from "./kfear.js";
import { InteractiveLineChart } from "./InteractiveLineChart.js";
import { MobileFold } from "./MobileFold.js";

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
  const isSolo = m.sizing.path === "SOLO"; // 코스닥 단독(코스피 미동반) → 0% 관찰
  const isGated = m.sizing.path === "GATED"; // 둘 다 얕음 → ×0.5
  const showRegimeOk = m.market === "코스닥" && m.signaling && m.regime === "SYSTEMIC";
  const ddTxt = m.creditDd !== null ? `${(m.creditDd * 100).toFixed(1)}%` : "—";
  const dispTxt = m.dispDev !== null ? `${m.dispDev >= 0 ? "+" : ""}${m.dispDev.toFixed(1)}%` : "—";
  const creditShallow = m.creditDd === null || m.creditDd * 100 > -8; // 게이트 기준
  const dispShallow = m.dispDev === null || m.dispDev > -7;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <span className="text-base font-semibold text-slate-700 sm:text-sm">{m.market}</span>
        {/* 코스닥 단독이면 등급과 무관하게 '관찰 — 동반 대기'(v3 §8-1). */}
        {isSolo ? (
          <span className="rounded bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-800" title={`FEAR·신호상 ${m.grade}이나 코스피 미동반이라 관찰(0%)`}>
            관찰 — 동반 대기
          </span>
        ) : (
          <span className={"rounded px-2 py-1 text-xs font-bold sm:py-0.5 " + GRADE_CLS[m.grade]}>
            공식 v5 · {m.grade} {GRADE_LABEL[m.grade]}
          </span>
        )}
      </div>

      {/* FEAR 게이지 */}
      <div className="mt-2 flex items-end gap-2">
        <span className={"text-4xl font-bold tabular-nums sm:text-3xl " + c.text}>{m.fear === null ? "—" : m.fear.toFixed(1)}</span>
        <span className="pb-1 text-xs text-slate-400">/ 100 공포지수</span>
      </div>
      <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={"h-full rounded-full " + c.bar} style={{ width: `${fearPct}%` }} />
        {/* 90 매수 임계선 */}
        <div className="absolute top-0 h-full w-px bg-slate-500/60" style={{ left: "90%" }} />
      </div>
      {/* 최종 권장 비중 — v4: 코스닥 단독=0% / 등급 기본비중 × 이중 얕음게이트. */}
      <div className="mt-2 rounded-md bg-slate-50 px-2.5 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-slate-500 sm:text-xs">공식 v5 권장 비중</span>
          <span className="flex flex-wrap items-baseline justify-end gap-1.5">
            {showRegimeOk && (
              <span
                className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
                title="시장 전반 공포(코스피 동반) — 과거 이 조합의 신뢰 높음"
              >
                ✓ 동반
              </span>
            )}
            {isSolo && (
              <span
                className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                title="코스닥 단독(코스피 미동반) — 6달 +0.5%·승률 50%·n=5 = 기대값 0. 동반 시 자동 승격."
              >
                관찰 — 코스피 동반 대기
              </span>
            )}
            <span className="text-3xl font-bold tabular-nums text-slate-800 sm:text-2xl">{m.sizing.pct}%</span>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-xs text-slate-400 sm:mt-0.5 sm:text-[10px]">
          <span>
            {isSolo ? (
              "코스닥 단독(코스피 미동반) → 0% 관찰"
            ) : m.sizing.weight === 0 ? (
              "신호 없음 → 0%"
            ) : (
              <>
                {m.grade} <span className="font-medium text-slate-500">{m.sizing.weight}</span> × 게이트{" "}
                <span className={"font-medium " + (isGated ? "text-amber-600" : "text-slate-500")}>{m.sizing.gate.toFixed(1)}</span>
              </>
            )}
          </span>
          <span>{m.nOn}/3 신호</span>
        </div>
      </div>

      {/* 공식 등급/권장비중을 덮지 않는 실험적 계단식 실행 레이어. */}
      <div className="mt-2 rounded-md border border-indigo-100 bg-indigo-50/60 px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-sm font-semibold text-indigo-800 sm:text-xs">계단식 실행 실험</span>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {m.stagedTargetPct === 60 && (
              <span className="rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-bold text-white">1차 진입 · 60%</span>
            )}
            {m.stagedTargetPct === 100 && (
              <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold text-white">2차 확인 · +40%</span>
            )}
            <span className="text-2xl font-bold tabular-nums text-indigo-900 sm:text-lg">목표 {m.stagedTargetPct}%</span>
          </div>
        </div>
        <div className="mt-0.5 text-xs font-medium text-indigo-600 sm:text-[10px]">예비대 기준 비중 · 공식 v5 비중과 별도</div>
        {m.stagedTargetPct === 60 ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-600 sm:text-[11px]">
            FEAR≥90·신용청산·이격도와 함께 반대매매 금액이 1년 상위 5%에 진입했습니다. 빠른 V자 반등 참여를 위한
            1차 구간이며 청산 정점 통과는 아직 미확인입니다.
          </p>
        ) : m.stagedTargetPct === 100 ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-600 sm:text-[11px]">
            같은 스파이크 이후 반대매매 금액이 2일 연속 엄격 감소했습니다. 청산 정점 통과 확인으로 남은 40%를
            추가한 상태입니다. 공식 STRONG은 별도 조건으로 판정됩니다.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-slate-500 sm:text-[11px]">현재 신규 계단식 진입 이벤트 없음. 목표 0% 표시는 기존 보유분 매도 지시가 아닙니다.</p>
        )}
        {(m.stage1Date || m.stage2Date) && (
          <div className="mt-1 text-[10px] tabular-nums text-slate-500">
            에피소드 {m.stageEpisodeId ?? "—"} · 1차 {m.stage1Date ?? "—"} · 2차 {m.stage2Date ?? "대기"}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs sm:mt-1 sm:text-[10px]">
          <span className={"rounded px-1.5 py-0.5 font-semibold " + (m.usConfirmationLabel === "미국 확인 없음" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700")}>
            미국 {m.usConfirmationLabel}
          </span>
          {m.usConfirmedAsOfDate && <span className="text-slate-500">첫 확인 {m.usConfirmedAsOfDate}</span>}
          {m.usConfirmationLabel === "미국 확인 없음" && (
            <span className="text-amber-700">· 국내 청산만으로 글로벌 약세장 지속 위험을 판별할 수 없음(비중 자동 축소 없음)</span>
          )}
        </div>
      </div>
      <MobileFold label="신호 조건 · 세부 차트 보기" className="mt-2">
      {/* 이중 얕음게이트 상태 (depth 사다리 폐지 — v4 §7-3). 신용·이격도 각각 얕음/깊음. */}
      {!isSolo && m.sizing.weight > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs tabular-nums sm:mt-1 sm:text-[10px]">
          <span className="text-slate-400">이중 게이트 →</span>
          <span className={"rounded px-1.5 py-0.5 " + (creditShallow ? "bg-slate-100 text-slate-400" : "bg-red-100 font-semibold text-red-700")}>
            신용 {ddTxt} {creditShallow ? "얕음" : "깊음✓"}
          </span>
          <span className={"rounded px-1.5 py-0.5 " + (dispShallow ? "bg-slate-100 text-slate-400" : "bg-red-100 font-semibold text-red-700")}>
            이격 {dispTxt} {dispShallow ? "얕음" : "깊음✓"}
          </span>
          {isGated ? (
            <span className="text-amber-600">· ⚠️ 둘 다 얕음 → ×0.5</span>
          ) : (
            <span className="text-slate-400">· 하나라도 깊으면 ×1.0(안 깎음)</span>
          )}
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
                  <span className="text-sm font-medium text-slate-700 sm:text-xs">{s.key}</span>
                  <span className={"shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold sm:text-[9px] " + LEVEL_CLS[s.level]}>
                    {LEVEL_LABEL[s.level]}
                  </span>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800 sm:text-xs">{s.value}</span>
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-slate-400 sm:mt-0 sm:text-[10px]">조건: {s.criteria}</div>
              <div className="text-xs leading-relaxed text-slate-500 sm:text-[11px]">{s.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      {/* FEAR 추이 + 90 임계선 (v4: F2=반대매매 금액 분위) */}
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
      {/* 신호별 원지표 추이 — 각 신호 임계선과 함께(FEAR 차트와 동일 상호작용). */}
      {m.s1History.length > 1 && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-400">S1 신용 DD 추이 (−8 경계 · −15 심각)</div>
          <InteractiveLineChart
            series={[{ points: m.s1History, color: "#0ea5e9", label: "신용 DD" }]}
            baselines={[-8, -15]}
            decimals={1}
            suffix="%"
            height={90}
          />
        </div>
      )}
      {m.s2History.length > 1 && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-400">S2 반대매매 금액 1년 분위 추이 (95 = 상위5%)</div>
          <div className="flex flex-wrap gap-x-2 text-[9px] text-slate-500">
            <span className="text-teal-700">● 1차 60% ({m.stage1OnDates.length})</span>
            <span className="text-amber-700">■ 첫 감소·추가 0% ({m.firstDeclineOnDates.length})</span>
            <span className="text-indigo-700">◆ 2차 +40% ({m.stage2OnDates.length})</span>
            <span className="text-red-600">○ 공식 v5 S2 ({m.s2OnDates.length})</span>
          </div>
          <div className="text-[9px] text-slate-400">계단식 이벤트와 공식 S2는 별도 상태입니다. 첫 감소는 참고만 하며 비중은 바뀌지 않습니다.</div>
          <InteractiveLineChart
            series={[{ points: m.s2History, color: "#f97316", label: "금액 분위" }]}
            baselines={[95]}
            eventMarkers={[
              { timestamps: m.s2OnDates, color: "#ef4444", label: "공식 v5 S2", shape: "ring" },
              { timestamps: m.firstDeclineOnDates, color: "#d97706", label: "첫 감소 · 추가 0%", shape: "square" },
              { timestamps: m.stage1OnDates, color: "#0d9488", label: "1차 60%", shape: "dot", showLabel: true },
              { timestamps: m.stage2OnDates, color: "#4f46e5", label: "2차 +40%", shape: "diamond", showLabel: true },
            ]}
            decimals={0}
            height={90}
          />
        </div>
      )}
      {m.s3History.length > 1 && (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-400">S3 60일선 이격도 편차 추이 (−8 과매도)</div>
          <InteractiveLineChart
            series={[{ points: m.s3History, color: "#8b5cf6", label: "이격도" }]}
            baselines={[-8]}
            decimals={1}
            suffix="%"
            height={90}
          />
        </div>
      )}
      </MobileFold>
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
    <div className="rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
      <div className="mb-2 flex flex-col items-start gap-0.5 sm:mb-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2">
        <h3 className="text-base font-semibold leading-tight text-slate-700 sm:text-sm">
          K-공포지수 · 캐피출레이션 바닥 <span className="mt-0.5 block text-[11px] font-normal text-slate-400 sm:mt-0 sm:inline sm:text-xs">코스피·코스닥 · FEAR(0~100)+3신호</span>
        </h3>
        <span className="text-xs text-slate-400">
          기준일 {fmtDate(asOf)}
          {staleDays > 6 && <span className="ml-1 font-medium text-amber-600">· ⚠️ {staleDays}일 지연(소스 확인)</span>}
        </span>
      </div>

      <div
        className={
          "mb-3 rounded px-3 py-2.5 text-sm font-semibold leading-relaxed sm:py-2 sm:font-medium " +
          (active.length > 0 ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600")
        }
      >
        오늘: {headline}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MarketCard m={kospi} />
        <MarketCard m={kosdaq} />
      </div>

      <MobileFold label="계산 방식 · 백테스트 설명 보기" className="mt-3">
      <div className="rounded bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        <strong>권장 비중 = 등급비중 × 이중게이트.</strong> 등급은 FEAR≥90 + 신호개수:{" "}
        <strong>STRONG(3신호) 100 · BUY(2신호) 60 · ARMED(1신호) 50 · WATCH(FEAR&lt;90&amp;2신호+) 45 · IDLE 0</strong>.{" "}
        <span className="text-slate-500">depth 사다리 폐지 [FEAR≥90 시점엔 신용이 이미 깊어 4단 무의미 — 20건 중 18건이 이미 DD≤−8%].</span>
        <span className="mt-1 block text-slate-500">
          <strong className="text-slate-600">이중 얕음게이트</strong>: 신용DD&gt;−8% <strong>AND</strong> 이격도&gt;−7% 둘 다 얕으면 ×0.5
          [둘다얕음 +5.6% vs 하나만얕음 +23.8% — <strong className="text-slate-600">하나만 얕은 건 안 깎음</strong>]. 신용·이격도는 무상관(−0.04) 독립정보.
        </span>
        <span className="mt-1 block text-slate-500">
          반대매매(S2)는 <strong className="text-slate-600">'절대금액 1년 상위5% 스파이크(6일내) &amp; 2일 연속 하락'</strong> — 청산 파도의 정점 통과를 확인 후 점등
          [v5 복원: MDD 7/8 개선 · STRONG 진입가 평균 −2.4~−3.9%, 비용: 빠른 V반등 2일 지각]. 수익 우열은 소표본 노이즈로 미증명 — 채택 근거는 MDD·진입가. 비중(÷미수금)은 분모왜곡이라 금지, F2도 동일 절대금액.
          코스닥 <strong>단독(코스피 미동반)은 0%</strong> — 동반 시 자동 승격.
        </span>
        <span className="mt-1 block text-slate-500">
          ※ 백테스트 n=15~20 소표본 — <strong className="text-slate-600">방향성만 신뢰</strong>(STRONG&gt;BUY 견고, ARMED 승률은 착시 가능). 6달 가중 +16.3%(현행 +11.5% 대비).
          "100%"는 이 시스템 배정 <strong>예비대의 100%</strong>이지 전체 몰빵 아님.
        </span>
      </div>
      <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-500">
        ⚠️ 이 지표는 <strong>소표본 백테스트</strong> 기반이며 <strong>투자 권유가 아닙니다</strong>. 모든 판단과 결과는
        사용자 책임입니다. FEAR·신호는 완전 워밍업(~311거래일) 이후만 신뢰하세요(차트는 그 이후만 표시).
      </p>
      </MobileFold>
    </div>
  );
}
