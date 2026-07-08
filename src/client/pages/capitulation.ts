import type { MarketSnapshot, SeriesPoint } from "../../shared/market.js";

/**
 * 캐피출레이션(투매) 바닥 감지 — 4개 신호의 O/X를 stored history에서 계산한다.
 * 백테스트된 시스템이 아니라 개별 경험칙을 보수적으로 묶은 설계이므로, "3/4 이상
 * 충족 → 분할 예비대"라는 구조 자체가 오류 허용치다. 매수 신호가 아니라 관찰 도구.
 *
 * 모든 입력 시리즈는 일별(거래일) 오름차순이므로 배열 index N ≈ N거래일.
 */

/** 공포 강도 4단계 (0 관망 → 3 심각). O/X와 별개로 "기준 대비 얼마나 깊은가"를 표시. */
export const CAP_LEVELS = ["관망", "경계", "공포", "심각"] as const;
export type CapLevel = 0 | 1 | 2 | 3;

export interface SignalResult {
  key: string;
  /** 데이터가 있어 판정 가능한가. */
  hasData: boolean;
  /** 충족(O)인가 (전체 조건 트리거). */
  met: boolean;
  /** 현재값 요약 (예: "-8.3%", "3.3%", "42.1"). */
  value: string;
  /** 판정 근거 한 줄. */
  detail: string;
  /** 이 신호가 O가 되는 조건(무엇을 보는지). */
  criteria: string;
  /** 공포 강도(0~3) — O/X와 별개로 이 축이 기준 대비 얼마나 극단인지. */
  level: CapLevel;
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
const na: SignalResult = { key: "", hasData: false, met: false, value: "—", detail: "데이터 없음", criteria: "", level: 0 };

/** 상위 꼬리 강도(②③): percentile 0..1(클수록 극단) → 0 관망 / 1 경계(≥90%) /
 *  2 공포(≥95%=충족선) / 3 심각(≥99%). */
function upperTailLevel(pct: number): CapLevel {
  if (pct >= 0.99) return 3;
  if (pct >= 0.95) return 2;
  if (pct >= 0.9) return 1;
  return 0;
}

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
  const criteria = "1년 피크 대비 −8%↓ & 10일 −3%↓ & 지수 동반↓";
  const credit = sumByDate(h.creditKospi ?? [], h.creditKosdaq ?? []);
  if (credit.length < 20) return { ...na, key: "① 신용잔고", criteria };
  const cur = credit.at(-1)!.v;
  const peak = Math.max(...last252(credit));
  const fromPeak = (cur / peak - 1) * 100;
  const chg10 = pctChange(credit, 10);
  const kospi10 = h.kospiClose && h.kospiClose.length > 10 ? pctChange(h.kospiClose, 10) : null;
  const indexDown = kospi10 !== null ? kospi10 < 0 : null;
  const met = fromPeak <= -8 && (chg10 ?? 0) <= -3 && indexDown === true;
  const idxNote = indexDown === null ? "지수 데이터 없음" : indexDown ? "지수 동반↓" : "지수 상승중(신호아님)";
  // 강도 = 피크 대비 되돌림 깊이 (−8% 충족선, −15%/−20%에서 2·3차 분할 설계).
  const level: CapLevel = fromPeak <= -20 ? 3 : fromPeak <= -8 ? 2 : fromPeak <= -4 ? 1 : 0;
  return {
    key: "① 신용잔고",
    hasData: true,
    met,
    value: `${cur.toFixed(1)}조`,
    detail: `피크 ${peak.toFixed(1)}조 대비 ${fromPeak.toFixed(1)}% · 10일 ${chg10?.toFixed(1) ?? "—"}% · ${idxNote}`,
    criteria,
    level,
  };
}

/** M/D label from a UTC-epoch trading-day timestamp (dates stored as Date.UTC). */
function fmtMD(t: number): string {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 최근 스파이크(≥95%ile)가 있었고 지금 2거래일 연속 감소 중인가 (피크아웃).
 *  spikeDay = 그 스파이크가 난 가장 최근 날 — "왜 지금 충족?"을 UI에 보여주려고. */
function spikeThenPeakOut(s: SeriesPoint[]): { peakOut: boolean; pctNow: number; spikeDay: SeriesPoint | null } {
  const win = last252(s);
  const cur = s.at(-1)!.v;
  const pctNow = percentile(win, cur);
  // 최근 SPIKE_WINDOW 거래일 중 95%ile 이상이 난 가장 최근 날.
  let spikeDay: SeriesPoint | null = null;
  for (const p of s.slice(-SPIKE_WINDOW)) {
    if (percentile(win, p.v) >= 0.95) spikeDay = p;
  }
  // 스파이크 후 2거래일 연속 감소 = 피크아웃.
  const peakOut = spikeDay !== null && decliningRun(s) >= 2;
  return { peakOut, pctNow, spikeDay };
}

/** ② 미수 반대매매 비중 스파이크 → 피크아웃. */
function forcedLiqSignal(h: MarketSnapshot["history"]): SignalResult {
  const criteria = "비중 최근 1년 상위5% 스파이크 후 2일 꺾임";
  const s = h.forcedLiqRatio ?? [];
  if (s.length < 20) return { ...na, key: "② 반대매매", criteria };
  const { peakOut, pctNow, spikeDay } = spikeThenPeakOut(s);
  // 강도 = 최근 창의 스파이크가 1년 상위 어디까지 갔나 (peak 후 현재가 내려와도 유지).
  const win = last252(s);
  const windowMaxPct = Math.max(...s.slice(-SPIKE_WINDOW).map((p) => percentile(win, p.v)));
  return {
    key: "② 반대매매",
    hasData: true,
    met: peakOut,
    value: `${s.at(-1)!.v.toFixed(1)}%`,
    detail:
      `비중 1년 ${(pctNow * 100).toFixed(0)}%ile` +
      (spikeDay ? ` · ${fmtMD(spikeDay.t)} 상위5%(${spikeDay.v.toFixed(1)}%)` : " · 최근 스파이크 없음") +
      (peakOut ? " · 피크아웃(2일↓)" : ""),
    criteria,
    level: upperTailLevel(windowMaxPct),
  };
}

/** ③ VKOSPI 상위 5% 후 꺾임 (−20% from 20일 고점 or 3일 연속↓). */
function vkospiSignal(h: MarketSnapshot["history"]): SignalResult {
  const criteria = "VKOSPI 1년 상위5% 후 −20%(20일고점) or 3일↓";
  const s = h.vkospi ?? [];
  if (s.length < 20) return { ...na, key: "③ VKOSPI", criteria };
  const win = last252(s);
  const cur = s.at(-1)!.v;
  const pctNow = percentile(win, cur);
  let highDay: SeriesPoint | null = null;
  for (const p of s.slice(-SPIKE_WINDOW)) {
    if (percentile(win, p.v) >= 0.95) highDay = p;
  }
  const max20 = Math.max(...s.slice(-20).map((p) => p.v));
  const down20 = cur <= max20 * 0.8;
  const met = highDay !== null && (down20 || decliningRun(s) >= 3);
  const windowMaxPct = Math.max(...s.slice(-SPIKE_WINDOW).map((p) => percentile(win, p.v)));
  return {
    key: "③ VKOSPI",
    hasData: true,
    met,
    value: cur.toFixed(1),
    detail:
      `1년 ${(pctNow * 100).toFixed(0)}%ile` +
      (highDay ? ` · ${fmtMD(highDay.t)} 상위5% 도달` : "") +
      (met ? " · 꺾임 확인" : ""),
    criteria,
    level: upperTailLevel(windowMaxPct),
  };
}

/** ④ 60일 이격도 과매도권 (레짐 적응: 1년 하위 5% or ≤92). */
function disparitySignal(h: MarketSnapshot["history"]): SignalResult {
  const criteria = "60일 이격도 ≤92 or 최근 1년 하위5%";
  const k = h.kospiClose ?? [];
  if (k.length < 60) return { ...na, key: "④ 이격도(60)", criteria };
  // 이격도 = 종가 / 60일 이평 × 100, 매 시점.
  const disp: SeriesPoint[] = [];
  for (let i = 59; i < k.length; i++) {
    const ma = k.slice(i - 59, i + 1).reduce((s, p) => s + p.v, 0) / 60;
    if (ma > 0) disp.push({ t: k[i].t, v: (k[i].v / ma) * 100 });
  }
  if (disp.length === 0) return { ...na, key: "④ 이격도(60)", criteria };
  const cur = disp.at(-1)!.v;
  const pctNow = percentile(last252(disp), cur);
  const met = cur <= 92 || pctNow <= 0.05;
  const dev = cur - 100; // 종가가 60일선 대비 몇 % (음수 = 아래로 이탈).
  const lowPct = pctNow < 0.01 ? "<1" : (pctNow * 100).toFixed(0);
  // 강도 = 과매도 깊이 (하위5% or ≤92 충족선, 하위1% or ≤88이면 심각).
  const level: CapLevel = pctNow <= 0.01 || cur <= 88 ? 3 : pctNow <= 0.05 || cur <= 92 ? 2 : pctNow <= 0.15 || cur <= 96 ? 1 : 0;
  return {
    key: "④ 이격도(60)",
    hasData: true,
    met,
    value: cur.toFixed(1),
    detail: `60일선 ${dev >= 0 ? "+" : ""}${dev.toFixed(1)}% · 1년 하위 ${lowPct}%${met ? " · 과매도권" : ""}`,
    criteria,
    level,
  };
}

export function computeCapitulation(snap: MarketSnapshot): CapitulationResult {
  const h = snap.history;
  const signals = [creditSignal(h), forcedLiqSignal(h), vkospiSignal(h), disparitySignal(h)];
  const withData = signals.filter((s) => s.hasData);
  const met = withData.filter((s) => s.met).length;
  return { signals, met, total: withData.length, triggered: met >= 3 };
}

