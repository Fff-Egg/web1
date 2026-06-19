import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { MarketSnapshot } from "../data/client.js";
import { fearGreedLabelKo } from "../../shared/market.js";
import type { SeriesPoint } from "../../shared/market.js";
import { MultiLineChart } from "./MarketChart.js";

const COL = {
  fg: "#0ea5e9",
  vix: "#e11d48",
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
  const snap = useQuery({ queryKey: ["market"], queryFn: () => api.marketLatest() });
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
            domain={[0, 100]}
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
            domain={[0, 100]}
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
        </div>
      )}

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

function MetricCard({
  id,
  title,
  subtitle,
  color,
  quote,
  history,
  domain,
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
  domain?: [number, number];
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
          <ChartBlock>
            <MultiLineChart
              series={[{ points: history, color, label: title }]}
              domain={domain}
              baselines={baselines}
              decimals={decimals}
              suffix={suffix}
            />
          </ChartBlock>
          <RefControls lines={lines} onChange={setLines} />
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
          <ChartBlock>
            <MultiLineChart
              series={[{ points: data.history.fearGreed, color: COL.fg, label: "F&G" }]}
              domain={[0, 100]}
              baselines={baselines}
              decimals={0}
            />
          </ChartBlock>
          <RefControls lines={lines} onChange={setLines} />
        </div>
      )}
    </Card>
  );
}

/**
 * The user-configurable slot: any TradingView symbol (VIX, WTI, a stock…).
 * Type a symbol and 적용 → server re-collects just that symbol. Reference lines
 * are remembered per-symbol.
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
      {!quote && data.history.custom.length === 0 ? (
        <Missing />
      ) : (
        <>
          {quote && (
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-800">{fmtNum(quote.value)}</span>
              {quote.changePct !== null && (
                <span className={`text-sm font-medium ${deltaColor(quote.changePct)}`}>
                  {arrow(quote.changePct)} {Math.abs(quote.changePct).toFixed(2)}%
                </span>
              )}
            </div>
          )}
          <div className="mt-0.5 text-xs text-slate-400">{symbol}</div>
          <ChartBlock>
            <MultiLineChart
              series={[{ points: data.history.custom, color: COL.vix, label: symbol }]}
              baselines={baselines}
              decimals={2}
            />
          </ChartBlock>
          <RefControls lines={lines} onChange={setLines} />
        </>
      )}
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

function ChartBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="mb-1 text-xs text-slate-400">최근 1년</div>
      {children}
    </div>
  );
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
