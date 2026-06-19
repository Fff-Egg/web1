import { useRef, useState } from "react";
import type { OHLC } from "../../shared/market.js";

interface Props {
  candles: OHLC[];
  /** User-set dashed reference lines. */
  baselines?: number[];
  /** Show the time (not just date) in the tooltip, for intraday timeframes. */
  intraday?: boolean;
  height?: number;
}

const W = 600;
const PAD = 8;
const UP = "#16a34a";
const DOWN = "#dc2626";

/**
 * Inline-SVG candlestick chart (no chart library). Stretches to its container
 * (preserveAspectRatio="none"); wicks stay 1px via vector-effect. Hovering shows
 * a crosshair + OHLC tooltip.
 */
export function CandleChart({ candles, baselines = [], intraday = false, height = 180 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (candles.length === 0) {
    return <div className="py-10 text-center text-xs text-slate-400">차트 데이터 없음</div>;
  }

  const lows = candles.map((c) => c.l);
  const highs = candles.map((c) => c.h);
  let lo = Math.min(...lows, ...baselines.filter((b) => Number.isFinite(b)));
  let hi = Math.max(...highs, ...baselines.filter((b) => Number.isFinite(b)));
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;

  const H = height;
  const n = candles.length;
  const slot = W / n;
  const bodyW = Math.max(slot * 0.6, 0.5);
  const cx = (i: number) => (i + 0.5) * slot;
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);

  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    setHover(Math.min(n - 1, Math.floor(ratio * n)));
  };

  const hc = hover !== null ? candles[hover] : null;
  const hoverRatio = hover !== null ? (hover + 0.5) / n : 0;
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2));

  return (
    <div className="relative" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }}>
        {baselines
          .filter((b) => b >= lo && b <= hi)
          .map((b) => (
            <line key={b} x1={0} x2={W} y1={y(b)} y2={y(b)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          ))}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? UP : DOWN;
          const yo = y(c.o);
          const yc = y(c.c);
          const top = Math.min(yo, yc);
          const bh = Math.max(Math.abs(yc - yo), 0.75);
          return (
            <g key={i}>
              <line x1={cx(i)} x2={cx(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bh} fill={color} />
            </g>
          );
        })}
        {hover !== null && (
          <line x1={cx(hover)} x2={cx(hover)} y1={0} y2={H} stroke="#94a3b8" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      {hc && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded bg-slate-800 px-2 py-1 text-[11px] leading-tight text-white shadow"
          style={{ left: `${Math.max(10, Math.min(90, hoverRatio * 100))}%` }}
        >
          <div className="mb-0.5 text-slate-300">
            {new Date(hc.t).toLocaleDateString("ko-KR")}
            {intraday && ` ${new Date(hc.t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
          </div>
          <div className="grid grid-cols-2 gap-x-2">
            <span className="text-slate-400">시 {fmt(hc.o)}</span>
            <span className="text-slate-400">고 {fmt(hc.h)}</span>
            <span className="text-slate-400">저 {fmt(hc.l)}</span>
            <span className={hc.c >= hc.o ? "text-green-400" : "text-red-400"}>종 {fmt(hc.c)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
