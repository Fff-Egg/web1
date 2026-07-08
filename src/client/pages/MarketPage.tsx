import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { MarketSnapshot } from "../data/client.js";
import { fearGreedLabelKo, TIMEFRAMES, TIMEFRAME_LABEL } from "../../shared/market.js";
import type { SeriesPoint, Timeframe } from "../../shared/market.js";
import { InteractiveLineChart } from "./InteractiveLineChart.js";
import type { LineSeries } from "./InteractiveLineChart.js";
import { CandleChart } from "./CandleChart.js";
import { CapitulationPanel } from "./CapitulationPanel.js";

const COL = {
  fg: "#0ea5e9",
  ndfi: "#7c3aed",
  s5fi: "#2563eb",
  kospi: "#2563eb",
  kosdaq: "#d97706",
};

/**
 * 시황분석 (Market Analysis) — daily snapshot dashboard, one chart per metric.
 *  layout: ① 공포·탐욕 / VIX  ② NDFI / S5FI  ③ 코스피 ADR / 코스닥 ADR
 * Each chart has user-configurable reference lines (저장: localStorage).
 *
 * The snapshot is collected once a day by the server (default 07시 KST). The
 * "지금 갱신" button forces a fresh collection on demand.
 */
export function MarketPage() {
  const qc = useQueryClient();
  // The snapshot is a once-a-day batch and (with 5y history) ~300KB of JSON —
  // don't re-download it on every tab switch / window refocus. '지금 갱신' and
  // symbol changes update the cache directly via setQueryData.
  const snap = useQuery({
    queryKey: ["market"],
    queryFn: () => api.marketLatest(),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => api.marketRefresh(),
    onSuccess: (data) => qc.setQueryData(["market"], data),
  });

  const data = snap.data;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">시황분석</h2>
          <p className="text-sm text-slate-500">
            {data ? `갱신: ${fmtTime(data.fetchedAt)}` : "하루 1회 자동 수집되는 시장 지표"}
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {refresh.isPending ? "갱신 중…" : "지금 갱신"}
        </button>
      </div>

      {snap.isLoading && <Placeholder text="불러오는 중…" />}
      {!snap.isLoading && !data && (
        <Placeholder text="아직 수집된 데이터가 없습니다. '지금 갱신'을 눌러 수집하세요." />
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          <FearGreedCard data={data} />
          <CustomCard data={data} />
          <MetricCard
            id="ndfi"
            title="NDFI · 나스닥 100"
            subtitle="50일선 위 비율"
            color={COL.ndfi}
            quote={data.breadth.ndfi}
            history={data.history.ndfi}
            decimals={1}
            suffix="%"
            defLow={25}
            defHigh={75}
          />
          <MetricCard
            id="s5fi"
            title="S5FI · S&P 500"
            subtitle="50일선 위 비율"
            color={COL.s5fi}
            quote={data.breadth.s5fi}
            history={data.history.s5fi}
            decimals={1}
            suffix="%"
            defLow={25}
            defHigh={75}
          />
          <MetricCard
            id="kospiAdr"
            title="코스피 ADR"
            subtitle="등락비율 · adrinfo.kr"
            color={COL.kospi}
            quote={adrToQuote(data.adr.kospi)}
            history={data.history.kospiAdr}
            decimals={2}
            defLow={25}
            defHigh={75}
          />
          <MetricCard
            id="kosdaqAdr"
            title="코스닥 ADR"
            subtitle="등락비율 · adrinfo.kr"
            color={COL.kosdaq}
            quote={adrToQuote(data.adr.kosdaq)}
            history={data.history.kosdaqAdr}
            decimals={2}
            defLow={25}
            defHigh={75}
          />
          <MetricCard
            id="creditKospi"
            title="코스피 신용잔고"
            subtitle="신용거래융자 · KOFIA"
            color={COL.kospi}
            quote={creditToQuote(data.credit.kospi)}
            history={data.history.creditKospi}
            decimals={1}
            suffix="조"
            defLow={null}
            defHigh={null}
          />
          <MetricCard
            id="creditKosdaq"
            title="코스닥 신용잔고"
            subtitle="신용거래융자 · KOFIA"
            color={COL.kosdaq}
            quote={creditToQuote(data.credit.kosdaq)}
            history={data.history.creditKosdaq}
            decimals={1}
            suffix="조"
            defLow={null}
            defHigh={null}
          />
        </div>
      )}

      {data && <LiquidityCard data={data} />}

      {data && <CapitulationPanel data={data} />}

      {data && data.errors.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-medium">일부 소스 수집 실패</p>
          <ul className="mt-1 list-disc pl-5">
            {data.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Timeframe (resolution) toggle for line charts — 일/주/월/년 ─────
type LineTf = "D" | "W" | "M" | "Y";
const TF_LABEL: Record<LineTf, string> = { D: "일", W: "주", M: "월", Y: "년" };
const TF_ORDER: LineTf[] = ["D", "W", "M", "Y"];

/** Downsample a daily series to weekly/monthly/yearly by keeping the last point
 *  in each bucket. "일" returns the data as-is. Input is ascending (the server
 *  stores history through sliceLastYear, which sorts), so no re-sort needed. */
function resample(points: SeriesPoint[], tf: LineTf): SeriesPoint[] {
  if (tf === "D" || points.length === 0) return points;
  const bucket = (t: number): string => {
    const d = new Date(t);
    if (tf === "Y") return `${d.getUTCFullYear()}`;
    if (tf === "M") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    return `w${Math.floor(t / (7 * 24 * 60 * 60_000))}`; // ISO-ish week bucket
  };
  const last = new Map<string, SeriesPoint>();
  for (const p of points) last.set(bucket(p.t), p); // ascending → last wins
  return [...last.values()];
}

function useLineTf(id: string): [LineTf, (t: LineTf) => void] {
  const [tf, setTf] = useState<LineTf>(() => {
    try {
      const r = localStorage.getItem(`mkt.tf.${id}`);
      return r === "W" || r === "M" || r === "Y" ? r : "D";
    } catch {
      return "D";
    }
  });
  const set = (t: LineTf) => {
    setTf(t);
    try {
      localStorage.setItem(`mkt.tf.${id}`, t);
    } catch {
      /* ignore */
    }
  };
  return [tf, set];
}

/** A line chart with a 일/주/월/년 toggle + wheel-zoom/pan/crosshair interaction. */
function LineChartBlock({
  id,
  series,
  baselines = [],
  decimals = 1,
  suffix = "",
  height = 150,
}: {
  id: string;
  series: LineSeries[];
  baselines?: number[];
  decimals?: number;
  suffix?: string;
  height?: number;
}) {
  const [tf, setTf] = useLineTf(id);
  // Memoized so baseline-input keystrokes (parent re-renders) don't re-bucket.
  const rs = useMemo(() => series.map((s) => ({ ...s, points: resample(s.points, tf) })), [series, tf]);
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-slate-400">휠=확대 · 드래그=이동</span>
        <div className="flex gap-0.5">
          {TF_ORDER.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={
                "rounded px-1.5 py-0.5 text-xs font-medium " +
                (tf === t ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-100")
              }
            >
              {TF_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {/* key={tf} remounts on resolution change so the viewport resets cleanly. */}
      <InteractiveLineChart key={tf} series={rs} baselines={baselines} decimals={decimals} suffix={suffix} height={height} />
    </div>
  );
}

// ─── Reference-line config (per chart, persisted in localStorage) ───

interface RefLines {
  low: number | null;
  high: number | null;
}

function useRefLines(key: string, def: RefLines) {
  const [v, setV] = useState<RefLines>(() => {
    try {
      const raw = localStorage.getItem(`mkt.ref.${key}`);
      return raw ? (JSON.parse(raw) as RefLines) : def;
    } catch {
      return def;
    }
  });
  const update = (nv: RefLines) => {
    setV(nv);
    try {
      localStorage.setItem(`mkt.ref.${key}`, JSON.stringify(nv));
    } catch {
      /* ignore quota */
    }
  };
  return [v, update] as const;
}

function RefControls({ lines, onChange }: { lines: RefLines; onChange: (v: RefLines) => void }) {
  const parse = (s: string): number | null => {
    const n = Number(s);
    return s.trim() === "" || Number.isNaN(n) ? null : n;
  };
  const box = "w-16 rounded border border-slate-200 px-1.5 py-0.5 text-slate-700";
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
      <span>기준선</span>
      <input
        type="number"
        value={lines.low ?? ""}
        onChange={(e) => onChange({ ...lines, low: parse(e.target.value) })}
        placeholder="낮음"
        className={box}
      />
      <input
        type="number"
        value={lines.high ?? ""}
        onChange={(e) => onChange({ ...lines, high: parse(e.target.value) })}
        placeholder="높음"
        className={box}
      />
    </div>
  );
}

// ─── Cards ──────────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

interface Quote {
  value: number;
  change: number | null;
  changePct: number | null;
  /** Optional note under the value (e.g. ADR 전일 종가). */
  note?: string;
}

function adrToQuote(q: MarketSnapshot["adr"]["kospi"]): Quote | null {
  if (!q) return null;
  const change = q.prevClose !== null ? Math.round((q.value - q.prevClose) * 100) / 100 : null;
  return { value: q.value, change, changePct: null, note: q.prevClose !== null ? `전일 ${q.prevClose.toFixed(2)}` : undefined };
}

function creditToQuote(q: MarketSnapshot["credit"]["kospi"]): Quote | null {
  if (!q) return null;
  const change = q.prevValue !== null ? Math.round((q.value - q.prevValue) * 100) / 100 : null;
  return { value: q.value, change, changePct: null, note: q.prevValue !== null ? `전일 ${q.prevValue.toFixed(1)}조` : undefined };
}

function MetricCard({
  id,
  title,
  subtitle,
  color,
  quote,
  history,
  decimals = 1,
  suffix = "",
  defLow,
  defHigh,
}: {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  quote: Quote | null;
  history: SeriesPoint[];
  decimals?: number;
  suffix?: string;
  defLow: number | null;
  defHigh: number | null;
}) {
  const [lines, setLines] = useRefLines(id, { low: defLow, high: defHigh });
  const baselines = [lines.low, lines.high].filter((x): x is number => x !== null);
  return (
    <Card title={title} subtitle={subtitle}>
      {!quote ? (
        <Missing />
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-800">
              {quote.value.toFixed(decimals)}
              {suffix}
            </span>
            {quote.changePct !== null && (
              <span className={`text-sm font-medium ${deltaColor(quote.changePct)}`}>
                {arrow(quote.changePct)} {Math.abs(quote.changePct).toFixed(2)}%
              </span>
            )}
            {quote.changePct === null && quote.change !== null && (
              <span className={`text-sm font-medium ${deltaColor(quote.change)}`}>
                {arrow(quote.change)} {Math.abs(quote.change).toFixed(decimals)}
              </span>
            )}
          </div>
          {quote.note && <div className="mt-0.5 text-xs text-slate-400">{quote.note}</div>}
          <LineChartBlock
            id={id}
            series={[{ points: history, color, label: title }]}
            baselines={baselines}
            decimals={decimals}
            suffix={suffix}
          />
          <RefControls lines={lines} onChange={setLines} />
        </>
      )}
    </Card>
  );
}

/**
 * 미국 순유동성 — the macro liquidity backdrop (Fed BS − RRP − TGA), overlaid
 * with reserve balances. Deliberately NOT a MetricCard: weekly/lagging, no
 * reference lines (no meaningful threshold), and a caution note — it's context,
 * NOT a buy/sell signal (it decoupled from the S&P during the 2023 AI rally).
 * Placed full-width at the bottom, lowest visual priority.
 */
function LiquidityCard({ data }: { data: MarketSnapshot }) {
  const liq = data.liquidity;
  return (
    <Card title="미국 순유동성" subtitle="연준자산 − 역레포(RRP) − TGA · 주간·후행">
      {!liq ? (
        <Missing />
      ) : (
        <>
          <div className="mb-2 inline-block rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            주간·후행 · 매매 신호 아님
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-800">${liq.net.toFixed(2)}T</span>
            {liq.net4wChange !== null && (
              <span className={`text-sm font-medium ${deltaColor(liq.net4wChange)}`}>
                {arrow(liq.net4wChange)} {Math.abs(liq.net4wChange).toFixed(2)}T
                <span className="ml-0.5 text-xs text-slate-400">(4주)</span>
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-400">
            {liq.reserves !== null && <span>지급준비금 ${liq.reserves.toFixed(2)}T</span>}
            {liq.tga !== null && <span>TGA ${liq.tga.toFixed(2)}T</span>}
            {liq.rrp !== null && <span>RRP ${liq.rrp.toFixed(2)}T</span>}
            {liq.asOf && <span>· {new Date(liq.asOf).toLocaleDateString("ko-KR")} 기준</span>}
          </div>
          {/* Two stacked single-line charts, each auto-scaled to its own range —
              a shared overlay wasted vertical space (net ~$5.8T vs reserves ~$3T
              sit ~3T apart, so each line only used a sliver of the axis). */}
          <div className="mt-1">
            <div className="text-xs font-medium text-teal-700">
              순유동성 <span className="font-normal text-slate-400">(연준자산 − RRP − TGA · ↑확대 ↓축소)</span>
            </div>
            <LineChartBlock
              id="netLiquidity"
              series={[{ points: data.history.netLiquidity, color: "#0d9488", label: "순유동성" }]}
              decimals={2}
              suffix="T"
              height={130}
            />
          </div>
          <div className="mt-3">
            <div className="text-xs font-medium text-amber-600">
              지급준비금 <span className="font-normal text-slate-400">($3T 아래 = 레포 스트레스 위험 구간)</span>
            </div>
            <LineChartBlock
              id="reserves"
              series={[{ points: data.history.reserves, color: "#f59e0b", label: "지급준비금" }]}
              decimals={2}
              suffix="T"
              height={130}
            />
          </div>
          <div className="mt-3">
            <div className="text-xs font-medium text-rose-600">
              TGA (재무부 계정){" "}
              <span className="font-normal text-slate-400">↑오르면 유동성 흡수(드레인) · ↓내리면 방출 — 순유동성과 역방향</span>
            </div>
            <LineChartBlock
              id="tga"
              series={[{ points: data.history.tga, color: "#e11d48", label: "TGA" }]}
              decimals={2}
              suffix="T"
              height={130}
            />
          </div>
          <div className="mt-3">
            <div className="text-xs font-medium text-slate-500">
              RRP (역레포){" "}
              <span className="font-normal text-slate-400">
                ↑흡수 ↓방출 · 2026 현재 ~0으로 소진(사라진 게 아니라 값이 0에 가까움)
              </span>
            </div>
            <LineChartBlock
              id="rrp"
              series={[{ points: data.history.rrp, color: "#64748b", label: "RRP" }]}
              decimals={3}
              suffix="T"
              height={110}
            />
          </div>
          <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-500">
            ⚠️ <strong>뒤에서 물이 차오르나 빠지나</strong>를 보는 배경 지표입니다. 이걸 보고 사고팔지 마세요 —
            AI·반도체 집중장에선 이 지표와 지수가 몇 달씩 <strong>반대로</strong> 간 전례(2023)가 있습니다. 레벨보다
            <strong> 4주 변화(방향)</strong>를 보세요.
          </p>
        </>
      )}
    </Card>
  );
}

function FearGreedCard({ data }: { data: MarketSnapshot }) {
  const fg = data.fearGreed;
  const [lines, setLines] = useRefLines("fearGreed", { low: 25, high: 75 });
  const baselines = [lines.low, lines.high].filter((x): x is number => x !== null);
  return (
    <Card title="공포·탐욕 지수" subtitle="CNN Fear & Greed">
      {!fg ? (
        <Missing />
      ) : (
        <div>
          <div className="flex items-end gap-3">
            <span className={`text-4xl font-bold ${fearGreedColor(fg.score)}`}>{Math.round(fg.score)}</span>
            <span className={`pb-1 text-sm font-medium ${fearGreedColor(fg.score)}`}>{fearGreedLabelKo(fg.score)}</span>
          </div>
          <div className="relative mt-3 h-2 rounded-full bg-gradient-to-r from-red-400 via-amber-300 to-green-400">
            <div
              className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded bg-slate-800"
              style={{ left: `${Math.max(0, Math.min(100, fg.score))}%` }}
            />
          </div>
          <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
            <Stat label="전일" value={fg.prevClose} />
            <Stat label="1주 전" value={fg.week} />
            <Stat label="1달 전" value={fg.month} />
            <Stat label="1년 전" value={fg.year} />
          </dl>
          <LineChartBlock
            id="fearGreed"
            series={[{ points: data.history.fearGreed, color: COL.fg, label: "F&G" }]}
            baselines={baselines}
            decimals={0}
          />
          <RefControls lines={lines} onChange={setLines} />
        </div>
      )}
    </Card>
  );
}

/**
 * The user-configurable slot: any TradingView symbol (VIX, WTI, a stock…),
 * shown as a candlestick chart with selectable timeframe (4시간/일/주/월/년).
 * Type a symbol and 적용 → server re-collects + stores it. Reference lines and
 * timeframe are remembered per-symbol. Only THIS card uses candles; the others
 * stay as line charts.
 */
function CustomCard({ data }: { data: MarketSnapshot }) {
  const qc = useQueryClient();
  const custom = data.custom;
  const symbol = custom?.symbol ?? "CBOE:VIX";
  const [draft, setDraft] = useState(symbol);
  const setSymbol = useMutation({
    mutationFn: (s: string) => api.setMarketSymbol(s),
    onSuccess: (snap) => {
      qc.setQueryData(["market"], snap);
      if (snap.custom?.symbol) setDraft(snap.custom.symbol);
    },
  });
  const [lines, setLines] = useRefLines(`custom:${symbol}`, { low: null, high: null });
  const baselines = [lines.low, lines.high].filter((x): x is number => x !== null);
  const quote = custom?.quote ?? null;
  const apply = () => {
    const s = draft.trim();
    if (s && s.toUpperCase() !== symbol.toUpperCase()) setSymbol.mutate(s);
  };

  const [tf, setTf] = useState<Timeframe>(() => {
    const saved = localStorage.getItem("mkt.tf.custom");
    return saved && (TIMEFRAMES as readonly string[]).includes(saved) ? (saved as Timeframe) : "1D";
  });
  const pickTf = (t: Timeframe) => {
    setTf(t);
    localStorage.setItem("mkt.tf.custom", t);
  };
  const candles = useQuery({
    queryKey: ["candles", symbol, tf],
    queryFn: () => api.marketCandles(symbol, tf),
    staleTime: 5 * 60_000,
  });

  return (
    <Card title={custom?.name || symbol} subtitle="TradingView · 직접 지정">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        className="mb-3 flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="예: AAPL · TSLA · 005930"
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={setSymbol.isPending}
          className="shrink-0 rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {setSymbol.isPending ? "…" : "적용"}
        </button>
      </form>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
        티커만 입력해도 됩니다: <code>AAPL</code> · <code>NVDA</code> · <code>005930</code>(삼성) ·{" "}
        <code>USOIL</code>(WTI) · <code>BTCUSD</code>. 안 잡히면 <code>거래소:티커</code>로 입력(예:{" "}
        <code>NASDAQ:AAPL</code>).
      </p>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-slate-800">{quote ? fmtNum(quote.value) : "—"}</span>
        {quote?.changePct != null && (
          <span className={`text-sm font-medium ${deltaColor(quote.changePct)}`}>
            {arrow(quote.changePct)} {Math.abs(quote.changePct).toFixed(2)}%
          </span>
        )}
        <span className="text-xs text-slate-400">{symbol}</span>
      </div>

      <div className="mt-3 flex gap-1">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => pickTf(t)}
            className={`rounded px-2 py-1 text-xs ${
              tf === t ? "bg-slate-800 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {TIMEFRAME_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {candles.isLoading || setSymbol.isPending ? (
          <div className="py-10 text-center text-xs text-slate-400">불러오는 중…</div>
        ) : candles.data && candles.data.candles.length > 0 ? (
          <CandleChart key={`${symbol}:${tf}`} candles={candles.data.candles} baselines={baselines} intraday={tf === "4h"} />
        ) : (
          <div className="py-10 text-center text-xs text-slate-400">
            캔들 데이터를 받지 못했습니다. 심볼을 확인하세요.
          </div>
        )}
      </div>
      <RefControls lines={lines} onChange={setLines} />
    </Card>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────

/** Compact number: keep small values precise, drop decimals on large ones. */
function fmtNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm font-medium text-slate-700">{value === null ? "—" : Math.round(value)}</dd>
    </div>
  );
}

function Missing() {
  return <div className="text-sm text-slate-400">데이터 없음</div>;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">
      {text}
    </div>
  );
}

function fearGreedColor(score: number): string {
  if (score <= 24) return "text-red-600";
  if (score <= 44) return "text-amber-600";
  if (score <= 55) return "text-slate-600";
  if (score <= 74) return "text-green-600";
  return "text-green-700";
}

function deltaColor(delta: number): string {
  if (delta > 0) return "text-green-600";
  if (delta < 0) return "text-red-600";
  return "text-slate-400";
}

function arrow(delta: number): string {
  if (delta > 0) return "▲";
  if (delta < 0) return "▼";
  return "■";
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
