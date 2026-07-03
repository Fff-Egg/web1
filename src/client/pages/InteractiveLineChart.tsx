import { useEffect, useRef, useState } from "react";
import type { SeriesPoint } from "../../shared/market.js";

export interface LineSeries {
  points: SeriesPoint[];
  color: string;
  label: string;
}

interface Props {
  series: LineSeries[];
  baselines?: number[];
  height?: number;
  decimals?: number;
  suffix?: string;
  /** Show time (not just date) in the tooltip — for intraday data. */
  intraday?: boolean;
}

const W = 600;
const PAD = 8;
const AXIS_W = 54;

/** ~5 nicely-rounded tick values between lo and hi. */
function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * Inline-SVG multi-line chart with the same TradingView-style interaction as the
 * candlestick slot: mouse-wheel zoom (anchored under the cursor), drag pan, a
 * right-hand price axis with gridlines + current-value tag, and a full crosshair
 * (vertical + horizontal) that reads the price at the cursor on the axis and each
 * series' value in a tooltip. Lines/gridlines are SVG (stretched horizontally);
 * all text is an HTML overlay so it isn't distorted by preserveAspectRatio="none".
 */
export function InteractiveLineChart({
  series,
  baselines = [],
  height = 150,
  decimals = 1,
  suffix = "",
  intraday = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const nonEmpty = series.filter((s) => s.points.length > 0);
  // Longest series drives the x-axis / index / dates.
  const ref0 = nonEmpty.reduce<SeriesPoint[]>((a, b) => (b.points.length > a.length ? b.points : a), [] as SeriesPoint[]);
  const n = ref0.length;

  const [view, setView] = useState(() => ({ count: Math.min(n || 1, 180), end: n }));
  useEffect(() => {
    setView({ count: Math.min(n || 1, 180), end: n });
  }, [n]);

  const [hover, setHover] = useState<{ ix: number; yRatio: number } | null>(null);
  const drag = useRef<{ x: number; end: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setView((v) => {
        const factor = e.deltaY < 0 ? 0.82 : 1.22;
        const count = Math.max(6, Math.min(n, Math.round(v.count * factor)));
        const start = v.end - v.count;
        const idxUnder = start + ratio * v.count;
        let newEnd = Math.round(idxUnder + (1 - ratio) * count);
        newEnd = Math.max(count, Math.min(n, newEnd));
        return { count, end: newEnd };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [n]);

  if (nonEmpty.length === 0 || n === 0) {
    return <div className="py-8 text-center text-xs text-slate-400">차트 데이터 없음</div>;
  }

  const count = Math.min(view.count, n);
  const end = Math.max(count, Math.min(n, view.end));
  const start = end - count;

  // Domain from the visible slice of EVERY series (+ baselines).
  const visValues: number[] = [];
  for (const s of nonEmpty) {
    // Align each series to the reference window by time range.
    const t0 = ref0[start].t;
    const t1 = ref0[end - 1].t;
    for (const p of s.points) if (p.t >= t0 && p.t <= t1) visValues.push(p.v);
  }
  for (const b of baselines) visValues.push(b);
  let lo = Math.min(...visValues);
  let hi = Math.max(...visValues);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const padV = (hi - lo) * 0.08;
  lo -= padV;
  hi += padV;

  const H = height;
  const t0 = ref0[start].t;
  const t1 = ref0[end - 1].t;
  const span = t1 - t0 || 1;
  const xOf = (t: number) => ((t - t0) / span) * W;
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);

  const pathOf = (pts: SeriesPoint[]) => {
    const seg = pts.filter((p) => p.t >= t0 && p.t <= t1);
    return seg.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  };

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (drag.current) {
      const dPts = Math.round(((e.clientX - drag.current.x) / rect.width) * count);
      setView((v) => ({ ...v, end: Math.max(count, Math.min(n, drag.current!.end - dPts)) }));
      return;
    }
    const rx = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    const ix = Math.min(end - 1, start + Math.round(rx * (count - 1)));
    const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setHover({ ix, yRatio });
  };

  const ticks = niceTicks(lo, hi);
  const lastPt = ref0[end - 1];
  const hIx = hover ? Math.max(start, Math.min(end - 1, hover.ix)) : null;
  const hoverT = hIx !== null ? ref0[hIx].t : null;
  // Price at the cursor's Y (crosshair readout on the axis).
  const cursorPrice = hover ? lo + (1 - hover.yRatio) * (hi - lo) : null;
  const hoverLeftPct = hoverT !== null ? Math.max(6, Math.min(94, (xOf(hoverT) / W) * 100)) : 0;
  const valAt = (pts: SeriesPoint[], t: number): number | null => {
    let best: SeriesPoint | null = null;
    for (const p of pts) if (best === null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best ? best.v : null;
  };

  return (
    <div className="flex select-none" style={{ height: H }}>
      <div
        ref={wrapRef}
        className="relative flex-1 cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          drag.current = null;
        }}
        onMouseDown={(e) => (drag.current = { x: e.clientX, end })}
        onMouseUp={() => (drag.current = null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }}>
          {ticks.map((t) => (
            <line key={`g${t}`} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="#f1f5f9" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {baselines
            .filter((b) => b >= lo && b <= hi)
            .map((b) => (
              <line key={`b${b}`} x1={0} x2={W} y1={y(b)} y2={y(b)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            ))}
          {nonEmpty.map((s) => (
            <path key={s.label} d={pathOf(s.points)} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          ))}
          {hover && hoverT !== null && (
            <>
              <line x1={xOf(hoverT)} x2={xOf(hoverT)} y1={0} y2={H} stroke="#94a3b8" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <line x1={0} x2={W} y1={hover.yRatio * H} y2={hover.yRatio * H} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              {nonEmpty.map((s) => {
                const v = valAt(s.points, hoverT);
                return v === null ? null : <circle key={s.label} cx={xOf(hoverT)} cy={y(v)} r={2.5} fill={s.color} />;
              })}
            </>
          )}
        </svg>

        {hover && hoverT !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded bg-slate-800 px-2 py-1 text-[11px] leading-tight text-white shadow"
            style={{ left: `${hoverLeftPct}%` }}
          >
            <div className="mb-0.5 text-slate-300">
              {new Date(hoverT).toLocaleDateString("ko-KR")}
              {intraday && ` ${new Date(hoverT).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
            </div>
            {nonEmpty.map((s) => {
              const v = valAt(s.points, hoverT);
              return (
                <div key={s.label} className="flex items-center gap-1 whitespace-nowrap">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {nonEmpty.length > 1 && <span className="text-slate-300">{s.label}</span>}
                  <span className="font-medium tabular-nums">
                    {v === null ? "—" : v.toFixed(decimals)}
                    {suffix}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* right price axis (HTML overlay) */}
      <div className="relative shrink-0 text-[10px] text-slate-400" style={{ width: AXIS_W, height: H }}>
        {ticks.map((t) => (
          <div key={t} className="absolute left-1 -translate-y-1/2 tabular-nums" style={{ top: y(t) }}>
            {t.toFixed(decimals)}
          </div>
        ))}
        <div
          className="absolute left-0 right-0 -translate-y-1/2 rounded-sm bg-slate-700 px-1 text-[10px] font-medium tabular-nums text-white"
          style={{ top: y(lastPt.v) }}
        >
          {lastPt.v.toFixed(decimals)}
        </div>
        {cursorPrice !== null && hover && (
          <div
            className="absolute left-0 right-0 -translate-y-1/2 rounded-sm bg-slate-500 px-1 text-[10px] font-medium tabular-nums text-white"
            style={{ top: `${hover.yRatio * H}px` }}
          >
            {cursorPrice.toFixed(decimals)}
          </div>
        )}
      </div>
    </div>
  );
}
