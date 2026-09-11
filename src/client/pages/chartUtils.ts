/**
 * Shared bits for the inline-SVG charts (CandleChart, InteractiveLineChart) so
 * their geometry and axis ticks can't drift apart.
 */

/** SVG viewBox width — stretched to the container (preserveAspectRatio="none"). */
export const CHART_W = 600;
/** Vertical padding inside the plot, px. */
export const CHART_PAD = 8;
/** Right price-axis gutter width, px. */
export const AXIS_W = 54;

/** ~5 nicely-rounded tick values between lo and hi. */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
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
