import { useEffect, useRef, useState } from "react";
import type { OHLC } from "../../shared/market.js";
import { CHART_W as W, CHART_PAD as PAD, AXIS_W, niceTicks } from "./chartUtils.js";

interface Props {
  candles: OHLC[];
  /** User-set dashed reference lines. */
  baselines?: number[];
  /** Show the time (not just date) in the tooltip, for intraday timeframes. */
  intraday?: boolean;
  height?: number;
}

const UP = "#16a34a";
const DOWN = "#dc2626";

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2));

/**
 * Inline-SVG candlestick chart (no chart library), TradingView-style:
 *  - mouse wheel zooms (anchored under the cursor), drag pans
 *  - right-hand price axis with gridlines + a current-price tag
 *  - hover crosshair + OHLC tooltip
 * Candles/gridlines are SVG (stretched horizontally); all text is HTML overlay
 * so it isn't distorted by preserveAspectRatio="none".
 */
export function CandleChart({ candles, baselines = [], intraday = false, height = 200 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const n = candles.length;

  // Viewport: show candles[end-count .. end]. Reset when the data changes.
  const [view, setView] = useState(() => ({ count: Math.min(n, 140), end: n }));
  useEffect(() => {
    setView({ count: Math.min(n, 140), end: n });
  }, [n]);

  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x: number; end: number } | null>(null);

  // Native non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setView((v) => {
        const factor = e.deltaY < 0 ? 0.82 : 1.22;
        const count = Math.max(8, Math.min(n, Math.round(v.count * factor)));
        const start = v.end - v.count;
        const idxUnder = start + ratio * v.count; // candle index under cursor
        let newEnd = Math.round(idxUnder + (1 - ratio) * count);
        newEnd = Math.max(count, Math.min(n, newEnd));
        return { count, end: newEnd };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [n]);

  if (n === 0) return <div className="py-10 text-center text-xs text-slate-400">차트 데이터 없음</div>;

  const count = Math.min(view.count, n);
  const end = Math.max(count, Math.min(n, view.end));
  const start = end - count;
  const vis = candles.slice(start, end);

  let lo = Math.min(...vis.map((c) => c.l));
  let hi = Math.max(...vis.map((c) => c.h));
  for (const b of baselines) if (b >= lo * 0.9 && b <= hi * 1.1) { lo = Math.min(lo, b); hi = Math.max(hi, b); }
  if (lo === hi) { lo -= 1; hi += 1; }
  const padV = (hi - lo) * 0.06;
  lo -= padV;
  hi += padV;

  const H = height;
  const slot = W / count;
  const bodyW = Math.max(slot * 0.62, 0.5);
  const cx = (i: number) => (i + 0.5) * slot;
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (drag.current) {
      const dCandles = Math.round(((e.clientX - drag.current.x) / rect.width) * count);
      const newEnd = Math.max(count, Math.min(n, drag.current.end - dCandles));
      setView((v) => ({ ...v, end: newEnd }));
      return;
    }
    const ratio = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    setHover(Math.min(count - 1, Math.floor(ratio * count)));
  };

  const ticks = niceTicks(lo, hi);
  const last = vis[vis.length - 1];
  const lastUp = last.c >= last.o;
  const hc = hover !== null ? vis[hover] : null;
  const hoverRatio = hover !== null ? (hover + 0.5) / count : 0;

  return (
    <div className="flex select-none" style={{ height: H }}>
      <div
        ref={wrapRef}
        className="relative flex-1 touch-pan-y cursor-crosshair"
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
          drag.current = null;
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, end };
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
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
          {vis.map((c, i) => {
            const color = c.c >= c.o ? UP : DOWN;
            const top = Math.min(y(c.o), y(c.c));
            const bh = Math.max(Math.abs(y(c.c) - y(c.o)), 0.75);
            return (
              <g key={i}>
                <line x1={cx(i)} x2={cx(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bh} fill={color} />
              </g>
            );
          })}
          {/* current price line */}
          <line x1={0} x2={W} y1={y(last.c)} y2={y(last.c)} stroke={lastUp ? UP : DOWN} strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          {hover !== null && (
            <line x1={cx(hover)} x2={cx(hover)} y1={0} y2={H} stroke="#94a3b8" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
        </svg>

        {/* OHLC tooltip */}
        {hc && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded bg-slate-800 px-2 py-1 text-xs leading-tight text-white shadow sm:text-[11px]"
            style={{ left: `${Math.max(12, Math.min(88, hoverRatio * 100))}%` }}
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

      {/* right price axis (HTML overlay — not distorted by the SVG stretch) */}
      <div className="relative shrink-0 text-[11px] text-slate-400 sm:text-[10px]" style={{ width: AXIS_W, height: H }}>
        {ticks.map((t) => (
          <div key={t} className="absolute left-1 -translate-y-1/2 tabular-nums" style={{ top: y(t) }}>
            {fmt(t)}
          </div>
        ))}
        <div
          className="absolute left-0 right-0 -translate-y-1/2 rounded-sm px-1 text-[10px] font-medium tabular-nums text-white"
          style={{ top: y(last.c), background: lastUp ? UP : DOWN }}
        >
          {fmt(last.c)}
        </div>
      </div>
    </div>
  );
}
