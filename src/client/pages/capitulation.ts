import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * 캐피출레이션(투매) 바닥 감지 — 4개 신호의 O/X를 stored history에서 계산한다.
 * 백테스트된 시스템이 아니라 개별 경험칙을 보수적으로 묶은 설계이므로, "3/4 이상
 * 충족 → 분할 예비대"라는 구조 자체가 오류 허용치다. 매수 신호가 아니라 관찰 도구.
 *
 * 모든 입력 시리즈는 일별(거래일) 오름차순이므로 배열 index N ≈ N거래일.
 */

export interface SignalResult {
  key: string;
  /** 데이터가 있어 판정 가능한가. */
  hasData: boolean;
  /** 충족(O)인가. */
  met: boolean;
  /** 현재값 요약 (예: "-8.3%", "3.3%", "42.1"). */
  value: string;
  /** 판정 근거 한 줄. */
  detail: string;
}

export interface CapitulationResult {
  signals: SignalResult[];
  /** 데이터 있는 신호 중 충족 개수 / 전체. */
  met: number;
  total: number;
  /** met ≥ 3 → 분할 예비대 고려. */
  triggered: boolean;
}

/** Merge two daily series by date (sum), for 신용잔고 유가+코스닥 합산. */
function sumByDate(a: SeriesPoint[], b: SeriesPoint[]): SeriesPoint[] {
  const m = new Map<number, number>();
  for (const p of a) m.set(p.t, p.v);
  for (const p of b) m.set(p.t, (m.get(p.t) ?? 0) + p.v);
  return [...m.entries()].map(([t, v]) => ({ t, v })).sort((x, y) => x.t - y.t);
}

/** Fraction of `window` ≤ v (0..1). */
function percentile(window: number[], v: number): number {
  if (window.length === 0) return 0;
  const n = window.filter((x) => x <= v).length;
  return n / window.length;
}

/** Value N trading days before the last point (clamped). */
function valueBack(s: SeriesPoint[], n: number): number | null {
  if (s.length === 0) return null;
  return s[Math.max(0, s.length - 1 - n)].v;
}

/** k-trading-day % change of the last point. */
function pctChange(s: SeriesPoint[], k: number): number | null {
  const cur = s.at(-1)?.v;
  const prev = valueBack(s, k);
  if (cur == null || prev == null || prev === 0) return null;
  return (cur / prev - 1) * 100;
}

/** Rolling ~1-year window (252 trading days), non-finite values dropped so a
 *  stray 0/NaN day can't distort the percentile denominator. */
const last252 = (s: SeriesPoint[]) => s.slice(-252).map((p) => p.v).filter((v) => Number.isFinite(v));
const na: SignalResult = { key: "", hasData: false, met: false, value: "—", detail: "데이터 없음" };

/** Lookback for "recent spike". Wider than the 2-day peak-out run so a spike
 *  that prints a couple days before price/vol actually rolls over still counts
 *  (반대매매·VKOSPI 저점은 흔히 T+2로 지연됨). */
const SPIKE_WINDOW = 8;

/**
 * Length of the strictly-declining tail, counted newest → older. Series are
 * ascending (past→newest, from sliceLastYear), so s[n-1] is today's value and a
 * declining tail means s[n-1] < s[n-2] < … Explicit indices (not s.at(-1)/-2/-3)
 * remove any ambiguity about which end is newest, and a non-finite point breaks
 * the run rather than silently comparing NaN.
 */
function decliningRun(s: SeriesPoint[]): number {
  let run = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (Number.isFinite(s[i].v) && Number.isFinite(s[i - 1].v) && s[i].v < s[i - 1].v) run++;
    else break;
  }
  return run;
}

/** ① 신용잔고 고점 대비 -8~10% 급감 (지수 하락 동행 필수). */
function creditSignal(h: MarketSnapshot["history"]): SignalResult {
  const credit = sumByDate(h.creditKospi ?? [], h.creditKosdaq ?? []);
  if (credit.length < 20) return { ...na, key: "① 신용잔고" };
  const cur = credit.at(-1)!.v;
  const peak = Math.max(...last252(credit));
  const fromPeak = (cur / peak - 1) * 100;
  const chg10 = pctChange(credit, 10);
  const kospi10 = h.kospiClose && h.kospiClose.length > 10 ? pctChange(h.kospiClose, 10) : null;
  const indexDown = kospi10 !== null ? kospi10 < 0 : null;
  const met = fromPeak <= -8 && (chg10 ?? 0) <= -3 && indexDown === true;
  const idxNote = indexDown === null ? "지수 데이터 없음" : indexDown ? "지수 동반↓" : "지수 상승중(신호아님)";
  return {
    key: "① 신용잔고",
    hasData: true,
    met,
    value: `${cur.toFixed(1)}조`,
    detail: `피크 ${peak.toFixed(1)}조 대비 ${fromPeak.toFixed(1)}% · 10일 ${chg10?.toFixed(1) ?? "—"}% · ${idxNote}`,
  };
}

/** 최근 스파이크(≥95%ile)가 있었고 지금 2거래일 연속 감소 중인가 (피크아웃). */
function spikeThenPeakOut(s: SeriesPoint[]): { spike: boolean; peakOut: boolean; pctNow: number } {
  const win = last252(s);
  const cur = s.at(-1)!.v;
  const pctNow = percentile(win, cur);
  // 최근 SPIKE_WINDOW 거래일 내 95%ile 이상 스파이크가 있었나.
  const spike = s.slice(-SPIKE_WINDOW).some((p) => percentile(win, p.v) >= 0.95);
  // 스파이크 후 2거래일 연속 감소 = 피크아웃.
  const peakOut = spike && decliningRun(s) >= 2;
  return { spike, peakOut, pctNow };
}

/** ② 미수 반대매매 비중 스파이크 → 피크아웃. */
function forcedLiqSignal(h: MarketSnapshot["history"]): SignalResult {
  const s = h.forcedLiqRatio ?? [];
  if (s.length < 20) return { ...na, key: "② 반대매매" };
  const { spike, peakOut, pctNow } = spikeThenPeakOut(s);
  return {
    key: "② 반대매매",
    hasData: true,
    met: peakOut,
    value: `${s.at(-1)!.v.toFixed(1)}%`,
    detail: `비중 1년 ${(pctNow * 100).toFixed(0)}%ile${spike ? " · 상위5% 스파이크" : ""}${peakOut ? " · 피크아웃(2일↓)" : ""}`,
  };
}

/** ③ VKOSPI 상위 5% 후 꺾임 (−20% from 20일 고점 or 3일 연속↓). */
function vkospiSignal(h: MarketSnapshot["history"]): SignalResult {
  const s = h.vkospi ?? [];
  if (s.length < 20) return { ...na, key: "③ VKOSPI" };
  const win = last252(s);
  const cur = s.at(-1)!.v;
  const pctNow = percentile(win, cur);
  const recentHigh = s.slice(-SPIKE_WINDOW).some((p) => percentile(win, p.v) >= 0.95);
  const max20 = Math.max(...s.slice(-20).map((p) => p.v));
  const down20 = cur <= max20 * 0.8;
  const met = recentHigh && (down20 || decliningRun(s) >= 3);
  return {
    key: "③ VKOSPI",
    hasData: true,
    met,
    value: cur.toFixed(1),
    detail: `1년 ${(pctNow * 100).toFixed(0)}%ile${recentHigh ? " · 상위5% 도달" : ""}${met ? " · 꺾임 확인" : ""}`,
  };
}

/** ④ 60일 이격도 과매도권 (레짐 적응: 1년 하위 5% or ≤92). */
function disparitySignal(h: MarketSnapshot["history"]): SignalResult {
  const k = h.kospiClose ?? [];
  if (k.length < 60) return { ...na, key: "④ 이격도(60)" };
  // 이격도 = 종가 / 60일 이평 × 100, 매 시점.
  const disp: SeriesPoint[] = [];
  for (let i = 59; i < k.length; i++) {
    const ma = k.slice(i - 59, i + 1).reduce((s, p) => s + p.v, 0) / 60;
    if (ma > 0) disp.push({ t: k[i].t, v: (k[i].v / ma) * 100 });
  }
  if (disp.length === 0) return { ...na, key: "④ 이격도(60)" };
  const cur = disp.at(-1)!.v;
  const pctNow = percentile(last252(disp), cur);
  const met = cur <= 92 || pctNow <= 0.05;
  return {
    key: "④ 이격도(60)",
    hasData: true,
    met,
    value: cur.toFixed(1),
    detail: `1년 하위 ${(pctNow * 100).toFixed(0)}%ile${met ? " · 과매도권" : ""}`,
  };
}

export function computeCapitulation(snap: MarketSnapshot): CapitulationResult {
  const h = snap.history;
  const signals = [creditSignal(h), forcedLiqSignal(h), vkospiSignal(h), disparitySignal(h)];
  const withData = signals.filter((s) => s.hasData);
  const met = withData.filter((s) => s.met).length;
  return { signals, met, total: withData.length, triggered: met >= 3 };
}

