import { useRef, useState } from "react";
import type { SeriesPoint } from "../../shared/market.js";

export interface ChartSeries {
  points: SeriesPoint[];
  /** Line color (CSS hex). */
  color: string;
  label: string;
}

interface Props {
  series: ChartSeries[];
  /** Fixed y-domain, else auto from the data with a little padding. */
  domain?: [number, number];
  /** Optional dashed reference line (e.g. 50 for breadth, 100 for ADR). */
  baseline?: number;
  height?: number;
  decimals?: number;
  suffix?: string;
}

const W = 600;
const PAD = 8;

/**
 * Lightweight inline-SVG multi-line chart with a hover crosshair + tooltip.
 * No chart library — keeps the bundle small. The SVG stretches to its container
 * (preserveAspectRatio="none"); strokes stay 1px via vector-effect.
 */
export function MultiLineChart({ series, domain, baseline, height = 150, decimals = 1, suffix = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const nonEmpty = series.filter((s) => s.points.length > 0);
  if (nonEmpty.length === 0) {
    return <div className="py-8 text-center text-xs text-slate-400">차트 데이터 없음</div>;
  }

  // Reference series (longest) drives the x-axis / hover index / dates.
  const ref0 = nonEmpty.reduce((a, b) => (b.points.length > a.points.length ? b : a)).points;
  const n = ref0.length;

  const allV = nonEmpty.flatMap((s) => s.points.map((p) => p.v));
  let lo = domain ? domain[0] : Math.min(...allV);
  let hi = domain ? domain[1] : Math.max(...allV);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  if (!domain) {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }

  const H = height;
  const x = (i: number, len: number) => (len <= 1 ? 0 : (i / (len - 1)) * W);
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);

  const pathOf = (pts: SeriesPoint[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i, pts.length).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (n - 1)));
  };

  const hoverRatio = hover === null ? 0 : n <= 1 ? 0 : hover / (n - 1);
  const hoverDate = hover !== null && ref0[hover] ? new Date(ref0[hover].t) : null;

  return (
    <div className="relative" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }}>
        {baseline !== undefined && baseline >= lo && baseline <= hi && (
          <line
            x1={0}
            x2={W}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="#cbd5e1"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {nonEmpty.map((s) => (
          <path
            key={s.label}
            d={pathOf(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hover !== null && (
          <line
            x1={x(hover, n)}
            x2={x(hover, n)}
            y1={0}
            y2={H}
            stroke="#94a3b8"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hover !== null &&
          nonEmpty.map((s) => {
            const idx = Math.min(hover, s.points.length - 1);
            const p = s.points[idx];
            return p ? <circle key={s.label} cx={x(idx, s.points.length)} cy={y(p.v)} r={2.5} fill={s.color} /> : null;
          })}
      </svg>

      {hover !== null && hoverDate && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded bg-slate-800 px-2 py-1 text-[11px] text-white shadow"
          style={{ left: `${Math.max(8, Math.min(92, hoverRatio * 100))}%` }}
        >
          <div className="mb-0.5 text-slate-300">{hoverDate.toLocaleDateString("ko-KR")}</div>
          {nonEmpty.map((s) => {
            const p = s.points[Math.min(hover, s.points.length - 1)];
            return (
              <div key={s.label} className="flex items-center gap-1 whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {nonEmpty.length > 1 && <span className="text-slate-300">{s.label}</span>}
                <span className="font-medium">
                  {p ? p.v.toFixed(decimals) : "—"}
                  {suffix}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
