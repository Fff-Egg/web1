import { useMemo } from "react";
import type { MarketSnapshot } from "../data/client.js";
import { computeUsEntry, STATE_LABEL, type UsState, type Tier } from "./usEntry.js";
import { InteractiveLineChart } from "./InteractiveLineChart.js";

/**
 * US 진입신호 실행기 — 시황분석 K-공포지수 바로 아래. 나스닥 진입신호를 절대값 2트랙
 * (A: TERM≥1.05 / B: TERM≥1.00 & HY≥4.5)으로 판정해 "지금 진입권인지 + 추격 판단"을
 * 보여준다. 검증된 지시서(usEntry.ts) 로직을 그대로 쓴다.
 * ⚠️ n=10 소표본 백테스트(2008급 미포함) 기반 관찰 도구이며 투자 권유가 아니다.
 */

const STATE_CLS: Record<UsState, string> = {
  IDLE: "bg-slate-200 text-slate-500",
  WATCH: "bg-amber-300 text-amber-900",
  ARMED: "bg-orange-500 text-white",
  ACTIVE_A: "bg-red-500 text-white",
  ACTIVE_B: "bg-red-600 text-white",
  ACTIVE_AB: "bg-red-700 text-white",
  POST: "bg-slate-300 text-slate-600",
};

const isActive = (s: UsState) => s === "ACTIVE_A" || s === "ACTIVE_B" || s === "ACTIVE_AB";

/** 활성 티어 행 색: 2 최대(짙은빨강) / 1 본대(빨강) / 0 조정매수(에메랄드). */
function tierActiveCls(t: Tier): string {
  return t === 2 ? "bg-red-700 text-white" : t === 1 ? "bg-red-500 text-white" : "bg-emerald-600 text-white";
}

function fmtDate(t: number | null): string {
  if (t === null) return "—";
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** TERM 값 → 색: <0.95 회색 / 0.95–1.00 노랑 / 1.00–1.05 주황 / ≥1.05 빨강. */
function termColor(term: number | null): { text: string; bar: string } {
  if (term === null) return { text: "text-slate-400", bar: "#94a3b8" };
  if (term >= 1.05) return { text: "text-red-600", bar: "#ef4444" };
  if (term >= 1.0) return { text: "text-orange-600", bar: "#f97316" };
  if (term >= 0.95) return { text: "text-amber-600", bar: "#f59e0b" };
  return { text: "text-slate-500", bar: "#94a3b8" };
}

/** 임계 대비 값 한 줄 (라벨 · 값 · 임계 눈금). */
function MetricRow({
  label,
  value,
  met,
  thresholds,
}: {
  label: string;
  value: string;
  met: boolean;
  thresholds: string;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span
        className={
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " +
          (met ? "bg-red-500 text-white" : "bg-slate-100 text-slate-400")
        }
      >
        {met ? "O" : "X"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-slate-700">{label}</span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">{value}</span>
        </div>
        <div className="text-[10px] text-slate-400">{thresholds}</div>
      </div>
    </div>
  );
}

export function USEntryPanel({ data }: { data: MarketSnapshot }) {
  const u = useMemo(() => computeUsEntry(data), [data]);
  const tc = termColor(u.term);
  const active = isActive(u.state);

  if (!u.hasData) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-700">US 진입신호 · 나스닥</h3>
        <p className="mt-2 rounded bg-slate-50 px-3 py-2 text-sm text-slate-500">
          데이터 수집 전 — '지금 갱신'을 눌러 VIX·VIX3M·HY OAS를 수집하세요.
        </p>
      </div>
    );
  }

  const ddTxt = u.dd !== null ? `${(u.dd * 100).toFixed(1)}%` : "—";
  const headline = active
    ? `${STATE_LABEL[u.state]} — 진입권 유효 (연속 ${u.activeDays}일차)${u.mega ? " · ⚡MEGA" : ""}`
    : u.tier0
      ? `조정 매수(Tier 0) — 나스닥 고점대비 ${ddTxt} & 200일선 위 · 소량 예비대`
      : u.state === "ARMED"
        ? "역전 시작 — B 판정 대기 (A까지 0.05)"
        : u.state === "WATCH"
          ? "접근 경보 — 아직 진입 조건 아님"
          : u.state === "POST"
            ? "발동 직후 참고창 (조건 소멸, 21거래일 내)"
            : "평시 — 진입 신호 없음";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">
          US 진입신호 · 나스닥{" "}
          <span className="text-xs font-normal text-slate-400">TERM(VIX/VIX3M) 2트랙 · A≥1.05 / B≥1.00&amp;HY≥4.5</span>
        </h3>
        <span className="text-xs text-slate-400">
          기준일 {fmtDate(u.asOf)} · HY {fmtDate(u.hyAsOf)}
        </span>
      </div>

      <div
        className={
          "mb-3 rounded px-3 py-2 text-sm font-medium " +
          (active ? "bg-red-50 text-red-700" : u.tier0 ? "bg-emerald-50 text-emerald-700" : "bg-slate-50 text-slate-600")
        }
      >
        오늘: {headline}
      </div>

      <div className="rounded-lg border border-slate-200 p-3">
        {/* 상태 배지 + Tier 0 칩 + TERM 큰 값 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={"rounded px-2 py-0.5 text-xs font-bold " + STATE_CLS[u.state]}>
            {u.state} {STATE_LABEL[u.state]}
          </span>
          {u.tier0 && <span className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">Tier 0 조정매수</span>}
          {u.mega && <span className="rounded bg-purple-700 px-2 py-0.5 text-xs font-bold text-white">⚡ MEGA (VIX≥40)</span>}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <span className={"text-3xl font-bold tabular-nums " + tc.text}>{u.term === null ? "—" : u.term.toFixed(3)}</span>
          <span className="pb-1 text-xs text-slate-400">TERM = VIX/VIX3M</span>
        </div>
        <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          {/* 0.90~1.10 구간을 게이지로(1.00·1.05 임계선). */}
          <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, ((( u.term ?? 0.9) - 0.9) / 0.2) * 100))}%`, background: tc.bar }} />
          <div className="absolute top-0 h-full w-px bg-slate-500/60" style={{ left: "50%" }} />
          <div className="absolute top-0 h-full w-px bg-red-500/70" style={{ left: "75%" }} />
        </div>

        {/* ACTIVE 추가 표시 — 추격 진입 판단용 */}
        {active && (
          <div className="mt-2 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800">
            <div className="flex items-baseline justify-between">
              <span className="font-medium">첫 발동 {fmtDate(u.firstFired)}</span>
              {u.nasdaqSince !== null && (
                <span className="tabular-nums">
                  첫 발동가 대비 나스닥{" "}
                  <span className="font-bold">
                    {u.nasdaqSince >= 0 ? "+" : ""}
                    {u.nasdaqSince.toFixed(1)}%
                  </span>
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-red-600">
              사이징: 일괄 기본 [백테스트 6달 +21.3%·승률 100%·최악 +2.7%] · 보험형 70% 즉시 + 30% @첫진입가 −10%
            </div>
          </div>
        )}

        {/* 3지표 */}
        <div className="mt-2 divide-y divide-slate-100">
          <MetricRow
            label="TERM (VIX/VIX3M)"
            value={u.term === null ? "—" : u.term.toFixed(3)}
            met={u.trackA}
            thresholds="A트리거 1.05 · ARMED 1.00 · WATCH 0.95"
          />
          <MetricRow
            label="HY OAS (신용확인)"
            value={u.hy === null ? "—" : `${u.hy.toFixed(2)}%`}
            met={u.trackB}
            thresholds="B조건 4.50 · WATCH 4.25 · T+1(D-1 관측)"
          />
          <MetricRow
            label="VIX"
            value={u.vix === null ? "—" : u.vix.toFixed(2)}
            met={u.mega}
            thresholds="MEGA 배지 40 (초대형 패닉)"
          />
          <MetricRow
            label="나스닥 고점대비 (Tier 0)"
            value={ddTxt}
            met={u.tier0}
            thresholds={`조정 −8% & 200일선 위 · 현재 200일선 ${u.dd === null ? "—" : u.above200 ? "위 ✓" : "아래 ✗"}`}
          />
        </div>

        {/* 3단 티어 구조 — 현재 위치 강조 (▶). 사용자 프레임워크의 예비대→본대→최대. */}
        <div className="mt-3 space-y-1">
          {(
            [
              { t: 2 as Tier, label: "Tier 2 확인 상향", cond: "AB 동시 / MEGA(VIX≥40)", size: "최대 사이징" },
              { t: 1 as Tier, label: "Tier 1 주 신호", cond: "A(TERM≥1.05) or B(≥1.00&HY≥4.5)", size: "본대 투입" },
              { t: 0 as Tier, label: "Tier 0 조정 매수", cond: "나스닥 −8% & 200일선 위", size: "소량 (계획 10~20%·예비대 선발대)" },
            ]
          ).map((row) => {
            const on = u.tier === row.t;
            return (
              <div
                key={row.t}
                className={
                  "flex flex-wrap items-center justify-between gap-x-2 rounded px-2 py-1 text-[11px] " +
                  (on ? tierActiveCls(row.t) : "bg-slate-50 text-slate-400")
                }
              >
                <span className="font-semibold">
                  {on ? "▶ " : ""}
                  {row.label}
                </span>
                <span className={"tabular-nums " + (on ? "opacity-90" : "")}>
                  {row.cond} → {row.size}
                </span>
              </div>
            );
          })}
        </div>

        {u.prevEpisode && (
          <div className="mt-2 text-[11px] text-slate-400">
            직전 에피소드: {fmtDate(u.prevEpisode.t)} ({u.prevEpisode.track}) — 경과 {u.prevEpisode.agoTradingDays}거래일
          </div>
        )}

        {/* TERM 추이 + 1.00/1.05 임계선 */}
        {u.termHistory.length > 1 && (
          <div className="mt-3">
            <div className="text-[10px] font-medium text-slate-400">TERM 추이 (1.05 = A트리거 · 1.00 = 역전)</div>
            <InteractiveLineChart
              series={[{ points: u.termHistory, color: tc.bar, label: "TERM" }]}
              baselines={[1.0, 1.05]}
              decimals={2}
              height={110}
            />
          </div>
        )}
        {/* HY OAS 추이 + 4.5 임계선 */}
        {u.hyHistory.length > 1 && (
          <div className="mt-2">
            <div className="text-[10px] font-medium text-slate-400">HY OAS 추이 (4.5 = B조건)</div>
            <InteractiveLineChart
              series={[{ points: u.hyHistory, color: "#7c3aed", label: "HY OAS" }]}
              baselines={[4.5]}
              decimals={2}
              suffix="%"
              height={100}
            />
          </div>
        )}
        {/* 나스닥 고점대비 낙폭 + −8% Tier 0 임계선 */}
        {u.ddHistory.length > 1 && (
          <div className="mt-2">
            <div className="text-[10px] font-medium text-slate-400">나스닥 고점대비 낙폭 (−8% = Tier 0 조정 임계)</div>
            <InteractiveLineChart
              series={[{ points: u.ddHistory, color: "#0d9488", label: "고점대비" }]}
              baselines={[-8]}
              decimals={1}
              suffix="%"
              height={100}
            />
          </div>
        )}
      </div>

      <div className="mt-3 rounded bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        <strong>3단 티어(예비대→본대→최대)</strong> — <strong>Tier 0 조정매수</strong>: 나스닥 −8% &amp; 200일선 위 → 소량(10~20%).{" "}
        <strong>Tier 1 주신호</strong>: A(TERM≥1.05) or B(≥1.00&amp;HY≥4.5) → 본대. <strong>Tier 2 확인상향</strong>: AB/MEGA(VIX≥40) → 최대.{" "}
        <span className="text-slate-500">
          TERM=VIX/VIX3M(만기구조 역전), HY=ICE BofA US HY OAS(신용). Tier 0의 <strong>200일선 필터</strong>가 강세장 조정과 하락장을
          가른다(−8% 시점에 하락장은 이미 200일선 아래라 자동 소멸). B 단독군이 백테스트 최고 품질(최악 +8.5%). 신호는 조건 지속 중 매일 유지(쿨다운 없음).
        </span>
        <span className="mt-1 block text-slate-500">
          ⚠️ Tier 0은 <strong>폭락/조정을 사전 구분 못 함</strong>(2020-02에도 켜져 1달 −17.6% 선제 피격 → 6달 +26.9% 회복) — 반드시 소량 전용,
          이후 A/B가 뜨면 본대가 들어가는 2단 구조. n=10~12 소표본(2008급 미포함) — 승률 100%는 표본의 산물. <strong>투자 권유가 아니며</strong> 모든 판단·결과는 사용자 책임.
        </span>
      </div>
    </div>
  );
}
