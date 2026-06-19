import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/client.js";
import type { MarketSnapshot } from "../data/client.js";
import { fearGreedLabelKo } from "../../shared/market.js";
import { MultiLineChart } from "./MarketChart.js";

const COL = { s5fi: "#2563eb", ndfi: "#7c3aed", kospi: "#2563eb", kosdaq: "#d97706", fg: "#0ea5e9" };

/**
 * 시황분석 (Market Analysis) — daily snapshot dashboard.
 *  - CNN Fear & Greed (시장 심리)
 *  - S5FI / NDFI (시장 폭 / breadth, % of index above 50-day MA)
 *  - ADR 코스피/코스닥 (등락비율)
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
          <BreadthCard data={data} />
          <AdrCard data={data} />
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

function FearGreedCard({ data }: { data: MarketSnapshot }) {
  const fg = data.fearGreed;
  return (
    <Card title="공포·탐욕 지수" subtitle="CNN Fear & Greed">
      {!fg ? (
        <Missing />
      ) : (
        <div>
          <div className="flex items-end gap-3">
            <span className={`text-4xl font-bold ${fearGreedColor(fg.score)}`}>{Math.round(fg.score)}</span>
            <span className={`pb-1 text-sm font-medium ${fearGreedColor(fg.score)}`}>
              {fearGreedLabelKo(fg.score)}
            </span>
          </div>
          {/* 0–100 scale bar with the current position marked. */}
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
              baseline={50}
              decimals={0}
            />
          </ChartBlock>
        </div>
      )}
    </Card>
  );
}

function BreadthCard({ data }: { data: MarketSnapshot }) {
  const { s5fi, ndfi } = data.breadth;
  return (
    <Card title="시장 폭 (50일선 위 비율)" subtitle="TradingView · EOD">
      {!s5fi && !ndfi ? (
        <Missing />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <BreadthItem label="S&P 500" sub="S5FI" q={s5fi} />
            <BreadthItem label="나스닥 100" sub="NDFI" q={ndfi} />
          </div>
          <ChartBlock legend={[{ label: "S&P 500", color: COL.s5fi }, { label: "나스닥 100", color: COL.ndfi }]}>
            <MultiLineChart
              series={[
                { points: data.history.s5fi, color: COL.s5fi, label: "S&P 500" },
                { points: data.history.ndfi, color: COL.ndfi, label: "나스닥 100" },
              ]}
              domain={[0, 100]}
              baseline={50}
              suffix="%"
            />
          </ChartBlock>
        </>
      )}
    </Card>
  );
}

function BreadthItem({
  label,
  sub,
  q,
}: {
  label: string;
  sub: string;
  q: MarketSnapshot["breadth"]["s5fi"];
}) {
  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">
        {label} <span className="text-slate-400">· {sub}</span>
      </div>
      {!q ? (
        <div className="mt-1 text-sm text-slate-400">—</div>
      ) : (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-800">{q.value.toFixed(1)}%</span>
          {q.changePct !== null && (
            <span className={`text-xs font-medium ${deltaColor(q.changePct)}`}>
              {arrow(q.changePct)} {Math.abs(q.changePct).toFixed(2)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AdrCard({ data }: { data: MarketSnapshot }) {
  const { kospi, kosdaq } = data.adr;
  return (
    <Card title="한국 ADR (등락비율)" subtitle="adrinfo.kr">
      {!kospi && !kosdaq ? (
        <Missing />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <AdrItem label="코스피" q={kospi} />
            <AdrItem label="코스닥" q={kosdaq} />
          </div>
          <ChartBlock legend={[{ label: "코스피", color: COL.kospi }, { label: "코스닥", color: COL.kosdaq }]}>
            <MultiLineChart
              series={[
                { points: data.history.kospiAdr, color: COL.kospi, label: "코스피" },
                { points: data.history.kosdaqAdr, color: COL.kosdaq, label: "코스닥" },
              ]}
              baseline={100}
              decimals={2}
            />
          </ChartBlock>
        </>
      )}
    </Card>
  );
}

function AdrItem({ label, q }: { label: string; q: MarketSnapshot["adr"]["kospi"] }) {
  const delta = q && q.prevClose !== null ? q.value - q.prevClose : null;
  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      {!q ? (
        <div className="mt-1 text-sm text-slate-400">—</div>
      ) : (
        <div className="mt-1">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-800">{q.value.toFixed(2)}</span>
            {delta !== null && (
              <span className={`text-xs font-medium ${deltaColor(delta)}`}>
                {arrow(delta)} {Math.abs(delta).toFixed(2)}
              </span>
            )}
          </div>
          {q.prevClose !== null && <div className="mt-0.5 text-xs text-slate-400">전일 {q.prevClose.toFixed(2)}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Small helpers ──────────────────────────────────────────────────

function ChartBlock({
  children,
  legend,
}: {
  children: React.ReactNode;
  legend?: { label: string; color: string }[];
}) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-slate-400">최근 1년</span>
        {legend && (
          <div className="flex gap-3">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1 text-xs text-slate-500">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>
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
