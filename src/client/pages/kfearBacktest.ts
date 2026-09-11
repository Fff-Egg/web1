import { hasUsConfirmationAround, type UsTierPoint } from "./kfearStaged.js";

/**
 * K-공포 계단식 실행 연구용 순수 백테스트.
 *
 * 공식 v5 등급/사이징에는 관여하지 않는다. 모든 전략은 같은 Stage 1 원재료
 * (FEAR≥90 + S1 + S3 + 반대매매 금액 252일 분위≥95%)에서 출발하며,
 * 21거래일 이내의 후보를 한 청산 에피소드로 병합한다.
 */

export const BACKTEST_HORIZONS = { "1m": 21, "3m": 63, "6m": 126 } as const;
export type BacktestHorizon = keyof typeof BACKTEST_HORIZONS;
export type BacktestStrategy = "A" | "B" | "C" | "D" | "E";
export type ExecutionBasis = "signal-close" | "next-session";

export const STRATEGY_LABEL: Record<BacktestStrategy, string> = {
  A: "스파이크 당일 100%",
  B: "1일 감소 확인 100%",
  C: "2일 감소 확인 100%",
  D: "3일 감소 확인 100%",
  E: "스파이크 60% + 2일 감소 40%",
};

export interface KFearBacktestDay {
  t: number;
  close: number;
  /** 다음 거래일 체결 연구용. 없으면 그 거래일 종가를 proxy로 사용한다. */
  open?: number | null;
  fear: number;
  s1: boolean;
  s3: boolean;
  amount: number;
  amountPercentile: number;
}

export interface BacktestOptions {
  fearArm?: number;
  spikePercentile?: number;
  spikeLookback?: number;
  episodeMergeDays?: number;
  usTimeline?: UsTierPoint[];
  usWindowTradingDays?: number;
}

export interface BacktestEpisode {
  id: string;
  stage1Index: number;
  lastCandidateIndex: number;
  decline1Index: number | null;
  decline2Index: number | null;
  decline3Index: number | null;
  usConfirmedAround: boolean | null;
}

export interface EpisodeOutcome {
  episodeId: string;
  strategy: BacktestStrategy;
  horizon: BacktestHorizon;
  basis: ExecutionBasis;
  signalDate: string;
  executionDate: string;
  returnPct: number;
  mddPct: number;
  usedCloseProxy: boolean;
}

export interface MetricSummary {
  n: number;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  winRatePct: number | null;
  meanMddPct: number | null;
  worstMddPct: number | null;
  worstReturnPct: number | null;
}

export interface StrategySummary {
  strategy: BacktestStrategy;
  label: string;
  independentEpisodes: number;
  signalDates: string[];
  horizons: Record<BacktestHorizon, MetricSummary>;
  usedNextSessionCloseProxy: boolean;
}

export interface PairedSummary {
  comparator: Exclude<BacktestStrategy, "E">;
  horizon: BacktestHorizon;
  n: number;
  meanExcessReturnPct: number | null;
  medianExcessReturnPct: number | null;
  stagedWinRatePct: number | null;
}

export interface StagedProgressSummary {
  stage1Episodes: number;
  reachedStage2: number;
  reachedStage2RatePct: number | null;
  meanTradingDaysToStage2: number | null;
  medianTradingDaysToStage2: number | null;
  noStage2Dates: string[];
}

export interface BasisBacktestReport {
  basis: ExecutionBasis;
  basisLabel: string;
  strategies: Record<BacktestStrategy, StrategySummary>;
  stagedProgress: StagedProgressSummary;
  pairedVsStaged: PairedSummary[];
  excluding2020: Record<BacktestStrategy, Record<BacktestHorizon, MetricSummary>>;
  usSplit: Record<
    BacktestStrategy,
    { confirmed: Record<BacktestHorizon, MetricSummary>; unconfirmed: Record<BacktestHorizon, MetricSummary> }
  >;
}

export interface KFearBacktestReport {
  range: { from: string | null; to: string | null; rows: number };
  episodes: BacktestEpisode[];
  signalClose: BasisBacktestReport;
  nextSession: BasisBacktestReport;
}

interface Execution {
  index: number;
  price: number;
  usedCloseProxy: boolean;
}

const dateKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Stage 1 에피소드와 1·2·3일 엄격 감소 확인일을 만든다. */
export function buildBacktestEpisodes(input: KFearBacktestDay[], options: BacktestOptions = {}): BacktestEpisode[] {
  const rows = [...input].sort((a, b) => a.t - b.t);
  const fearArm = options.fearArm ?? 90;
  const spikePercentile = options.spikePercentile ?? 0.95;
  const spikeLookback = options.spikeLookback ?? 6;
  const mergeDays = options.episodeMergeDays ?? 21;
  const spike = rows.map((row) => finite(row.amountPercentile) && row.amountPercentile >= spikePercentile);
  const spikeWithin = rows.map((_, i) => spike.slice(Math.max(0, i - spikeLookback + 1), i + 1).some(Boolean));
  const declineRun = new Array<number>(rows.length).fill(0);
  for (let i = 1; i < rows.length; i++) {
    declineRun[i] = finite(rows[i].amount) && finite(rows[i - 1].amount) && rows[i].amount < rows[i - 1].amount
      ? declineRun[i - 1] + 1
      : 0;
  }

  const episodes: BacktestEpisode[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!(row.fear >= fearArm && row.s1 && row.s3 && spike[i])) continue;
    const current = episodes[episodes.length - 1];
    if (current && i - current.lastCandidateIndex <= mergeDays) current.lastCandidateIndex = i;
    else {
      episodes.push({
        id: `episode-${dateKey(row.t)}`,
        stage1Index: i,
        lastCandidateIndex: i,
        decline1Index: null,
        decline2Index: null,
        decline3Index: null,
        usConfirmedAround: options.usTimeline
          ? hasUsConfirmationAround(options.usTimeline, row.t, options.usWindowTradingDays ?? 21)
          : null,
      });
    }
  }

  for (const episode of episodes) {
    const end = Math.min(rows.length - 1, episode.lastCandidateIndex + spikeLookback - 1);
    for (let i = episode.stage1Index + 1; i <= end; i++) {
      if (!spikeWithin[i]) continue;
      if (episode.decline1Index === null && declineRun[i] >= 1) episode.decline1Index = i;
      if (episode.decline2Index === null && declineRun[i] >= 2) episode.decline2Index = i;
      if (episode.decline3Index === null && declineRun[i] >= 3) episode.decline3Index = i;
    }
  }
  return episodes;
}

function signalIndex(episode: BacktestEpisode, strategy: BacktestStrategy): number | null {
  if (strategy === "A" || strategy === "E") return episode.stage1Index;
  if (strategy === "B") return episode.decline1Index;
  if (strategy === "C") return episode.decline2Index;
  return episode.decline3Index;
}

function executionAt(rows: KFearBacktestDay[], signal: number | null, basis: ExecutionBasis): Execution | null {
  if (signal === null) return null;
  if (basis === "signal-close") {
    const price = rows[signal]?.close;
    return finite(price) && price > 0 ? { index: signal, price, usedCloseProxy: false } : null;
  }
  const index = signal + 1;
  const row = rows[index];
  if (!row) return null;
  if (finite(row.open) && row.open > 0) return { index, price: row.open, usedCloseProxy: false };
  return finite(row.close) && row.close > 0 ? { index, price: row.close, usedCloseProxy: true } : null;
}

/** 실제 일별 평가금액으로 한 에피소드의 수익률과 MDD를 계산한다. */
export function evaluateEpisode(
  input: KFearBacktestDay[],
  episode: BacktestEpisode,
  strategy: BacktestStrategy,
  horizon: BacktestHorizon,
  basis: ExecutionBasis,
): EpisodeOutcome | null {
  const rows = [...input].sort((a, b) => a.t - b.t);
  const signal = signalIndex(episode, strategy);
  const first = executionAt(rows, signal, basis);
  if (signal === null || first === null) return null;
  const end = first.index + BACKTEST_HORIZONS[horizon];
  if (!rows[end] || !finite(rows[end].close) || rows[end].close <= 0) return null;
  const second = strategy === "E" ? executionAt(rows, episode.decline2Index, basis) : null;
  const equity = [1];
  for (let i = first.index; i <= end; i++) {
    const price = rows[i].close;
    if (!finite(price) || price <= 0) return null;
    if (strategy === "E") {
      const secondLeg = second && i >= second.index ? 0.4 * (price / second.price) : 0.4;
      equity.push(0.6 * (price / first.price) + secondLeg);
    } else {
      equity.push(price / first.price);
    }
  }
  let peak = equity[0];
  let mdd = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    mdd = Math.min(mdd, value / peak - 1);
  }
  return {
    episodeId: episode.id,
    strategy,
    horizon,
    basis,
    signalDate: dateKey(rows[signal].t),
    executionDate: dateKey(rows[first.index].t),
    returnPct: (equity[equity.length - 1] - 1) * 100,
    mddPct: mdd * 100,
    usedCloseProxy: first.usedCloseProxy || Boolean(second?.usedCloseProxy),
  };
}

function summarize(outcomes: EpisodeOutcome[]): MetricSummary {
  const returns = outcomes.map((row) => row.returnPct);
  const mdds = outcomes.map((row) => row.mddPct);
  return {
    n: outcomes.length,
    meanReturnPct: mean(returns),
    medianReturnPct: median(returns),
    winRatePct: outcomes.length ? (returns.filter((value) => value > 0).length / outcomes.length) * 100 : null,
    meanMddPct: mean(mdds),
    worstMddPct: mdds.length ? Math.min(...mdds) : null,
    worstReturnPct: returns.length ? Math.min(...returns) : null,
  };
}

function outcomesFor(
  rows: KFearBacktestDay[],
  episodes: BacktestEpisode[],
  strategy: BacktestStrategy,
  horizon: BacktestHorizon,
  basis: ExecutionBasis,
): EpisodeOutcome[] {
  return episodes
    .map((episode) => evaluateEpisode(rows, episode, strategy, horizon, basis))
    .filter((outcome): outcome is EpisodeOutcome => outcome !== null);
}

function basisReport(rows: KFearBacktestDay[], episodes: BacktestEpisode[], basis: ExecutionBasis): BasisBacktestReport {
  const strategyIds: BacktestStrategy[] = ["A", "B", "C", "D", "E"];
  const horizonIds = Object.keys(BACKTEST_HORIZONS) as BacktestHorizon[];
  const strategies = {} as Record<BacktestStrategy, StrategySummary>;
  const excluding2020 = {} as BasisBacktestReport["excluding2020"];
  const usSplit = {} as BasisBacktestReport["usSplit"];

  for (const strategy of strategyIds) {
    const signaled = episodes.filter((episode) => signalIndex(episode, strategy) !== null);
    const horizons = {} as Record<BacktestHorizon, MetricSummary>;
    const no2020 = {} as Record<BacktestHorizon, MetricSummary>;
    const confirmed = {} as Record<BacktestHorizon, MetricSummary>;
    const unconfirmed = {} as Record<BacktestHorizon, MetricSummary>;
    let usedNextSessionCloseProxy = false;
    for (const horizon of horizonIds) {
      const all = outcomesFor(rows, episodes, strategy, horizon, basis);
      horizons[horizon] = summarize(all);
      usedNextSessionCloseProxy ||= all.some((outcome) => outcome.usedCloseProxy);
      no2020[horizon] = summarize(all.filter((outcome) => !outcome.signalDate.startsWith("2020-")));
      const confirmedIds = new Set(episodes.filter((episode) => episode.usConfirmedAround === true).map((episode) => episode.id));
      const unconfirmedIds = new Set(episodes.filter((episode) => episode.usConfirmedAround === false).map((episode) => episode.id));
      confirmed[horizon] = summarize(all.filter((outcome) => confirmedIds.has(outcome.episodeId)));
      unconfirmed[horizon] = summarize(all.filter((outcome) => unconfirmedIds.has(outcome.episodeId)));
    }
    strategies[strategy] = {
      strategy,
      label: STRATEGY_LABEL[strategy],
      independentEpisodes: signaled.length,
      signalDates: signaled.map((episode) => dateKey(rows[signalIndex(episode, strategy)!].t)),
      horizons,
      usedNextSessionCloseProxy,
    };
    excluding2020[strategy] = no2020;
    usSplit[strategy] = { confirmed, unconfirmed };
  }

  const gaps = episodes
    .filter((episode) => episode.decline2Index !== null)
    .map((episode) => episode.decline2Index! - episode.stage1Index);
  const stagedProgress: StagedProgressSummary = {
    stage1Episodes: episodes.length,
    reachedStage2: gaps.length,
    reachedStage2RatePct: episodes.length ? (gaps.length / episodes.length) * 100 : null,
    meanTradingDaysToStage2: mean(gaps),
    medianTradingDaysToStage2: median(gaps),
    noStage2Dates: episodes.filter((episode) => episode.decline2Index === null).map((episode) => dateKey(rows[episode.stage1Index].t)),
  };

  const pairedVsStaged: PairedSummary[] = [];
  for (const comparator of ["A", "B", "C", "D"] as const) {
    for (const horizon of horizonIds) {
      const stagedById = new Map(outcomesFor(rows, episodes, "E", horizon, basis).map((outcome) => [outcome.episodeId, outcome]));
      const differences: number[] = [];
      for (const other of outcomesFor(rows, episodes, comparator, horizon, basis)) {
        const staged = stagedById.get(other.episodeId);
        if (staged) differences.push(staged.returnPct - other.returnPct);
      }
      pairedVsStaged.push({
        comparator,
        horizon,
        n: differences.length,
        meanExcessReturnPct: mean(differences),
        medianExcessReturnPct: median(differences),
        stagedWinRatePct: differences.length ? (differences.filter((value) => value > 0).length / differences.length) * 100 : null,
      });
    }
  }
  return {
    basis,
    basisLabel: basis === "signal-close" ? "신호일 종가(연구 패리티용)" : "다음 코스피 거래일 체결(시가 우선)",
    strategies,
    stagedProgress,
    pairedVsStaged,
    excluding2020,
    usSplit,
  };
}

export function runKFearBacktest(input: KFearBacktestDay[], options: BacktestOptions = {}): KFearBacktestReport {
  const rows = [...input]
    .filter((row) => finite(row.close) && row.close > 0)
    .sort((a, b) => a.t - b.t);
  const episodes = buildBacktestEpisodes(rows, options);
  return {
    range: {
      from: rows.length ? dateKey(rows[0].t) : null,
      to: rows.length ? dateKey(rows[rows.length - 1].t) : null,
      rows: rows.length,
    },
    episodes,
    signalClose: basisReport(rows, episodes, "signal-close"),
    nextSession: basisReport(rows, episodes, "next-session"),
  };
}

export const __test = { dateKey, median, mean, executionAt, signalIndex, summarize };
