/**
 * K-공포 계단식 실행 실험.
 *
 * 공식 v5 S2/STRONG/권장비중을 바꾸지 않고, 이미 계산된 일별 FEAR·S1·S3·
 * 반대매매 금액 분위 위에 "스파이크 60% → 2일 감소 +40%" 이벤트만 얹는다.
 * 이 모듈의 target은 예비대 기준 실행 에피소드 목표이며 매도 신호가 아니다.
 */

export type StagedTargetPct = 0 | 60 | 100;
export type StagedAddedPct = 0 | 40 | 60;
export type UsTierValue = 0 | 1 | 2 | null;
export type UsConfirmationLabel = "Tier0 확인" | "Tier1 확인" | "Tier2 확인" | "미국 확인 없음";

export interface StagedSignalInput {
  t: number;
  fear: number | null;
  s1: boolean;
  s3: boolean;
  amount: number | null;
  amountPercentile: number | null;
  officialS2: boolean;
}

export interface StagedExecutionDay {
  t: number;
  spikeToday: boolean;
  spikeWithin6Days: boolean;
  spikePeakDate: string | null;
  spikeDaysAgo: number | null;
  decline1: boolean;
  decline2: boolean;
  stage1EntryEvent: boolean;
  stage2UpgradeEvent: boolean;
  stageEpisodeId: string | null;
  stage1Date: string | null;
  stage2Date: string | null;
  stagedTargetPct: StagedTargetPct;
  stagedAddedPct: StagedAddedPct;
  officialS2: boolean;
  officialStrong: boolean;
}

export interface StagedOptions {
  fearArm?: number;
  spikePercentile?: number;
  spikeLookback?: number;
  episodeMergeDays?: number;
}

export interface UsTierPoint {
  t: number;
  tier: UsTierValue;
  /** Tier0·1·2를 합친 21거래일 에피소드의 첫 점등일. */
  episodeStart: boolean;
}

export interface LiveUsConfirmation {
  usTierNow: UsTierValue;
  usConfirmedAsOfDate: string | null;
  usConfirmationLabel: UsConfirmationLabel;
}

const DAY_MS = 86_400_000;
const dateKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
const dayNumber = (t: number): number => Math.floor(t / DAY_MS);

/**
 * Stage 1은 에피소드에서 한 번만 60%를 추가한다. 같은 에피소드의 추가 스파이크는
 * 최근-6일 확인창을 갱신하지만 60%를 중복 추가하지 않는다. Stage 2는 Stage 1이 있었던
 * 같은 에피소드에서만 한 번 발생한다. 에피소드 창이 끝나 target=0이 되는 것은
 * "신규 실행 이벤트 없음"이라는 뜻이지 보유분 매도 지시가 아니다.
 */
export function computeStagedExecutionTimeline(
  input: StagedSignalInput[],
  options: StagedOptions = {},
): StagedExecutionDay[] {
  const fearArm = options.fearArm ?? 90;
  const spikePercentile = options.spikePercentile ?? 0.95;
  const spikeLookback = options.spikeLookback ?? 6;
  const episodeMergeDays = options.episodeMergeDays ?? 21;
  const rows = [...input].sort((a, b) => a.t - b.t);
  const out: StagedExecutionDay[] = [];

  let episode: {
    id: string;
    stage1Index: number;
    stage1Date: string;
    stage2Date: string | null;
    stage2Done: boolean;
    lastCandidateIndex: number;
  } | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const amount = row.amount ?? NaN;
    const amountPct = row.amountPercentile ?? NaN;
    const spikeToday = Number.isFinite(amountPct) && amountPct >= spikePercentile;
    const decline1 =
      i >= 1 && Number.isFinite(amount) && Number.isFinite(rows[i - 1].amount ?? NaN) && amount < (rows[i - 1].amount as number);
    const decline2 =
      i >= 2 &&
      decline1 &&
      Number.isFinite(rows[i - 2].amount ?? NaN) &&
      (rows[i - 1].amount as number) < (rows[i - 2].amount as number);

    let spikePeakIndex = -1;
    for (let j = Math.max(0, i - spikeLookback + 1); j <= i; j++) {
      const pct = rows[j].amountPercentile ?? NaN;
      const candidateAmount = rows[j].amount ?? NaN;
      if (!Number.isFinite(pct) || pct < spikePercentile || !Number.isFinite(candidateAmount)) continue;
      if (spikePeakIndex < 0 || candidateAmount > (rows[spikePeakIndex].amount as number)) spikePeakIndex = j;
    }
    const spikeWithin6Days = spikePeakIndex >= 0;
    const stage1Candidate = row.fear !== null && row.fear >= fearArm && row.s1 && row.s3 && spikeToday;

    if (episode && i - episode.lastCandidateIndex > episodeMergeDays) episode = null;

    let stage1EntryEvent = false;
    if (stage1Candidate) {
      if (!episode) {
        const d = dateKey(row.t);
        episode = {
          id: `stage-${d}`,
          stage1Index: i,
          stage1Date: d,
          stage2Date: null,
          stage2Done: false,
          lastCandidateIndex: i,
        };
        stage1EntryEvent = true;
      } else {
        episode.lastCandidateIndex = i;
      }
    }

    const stage2UpgradeEvent = Boolean(
      episode && !episode.stage2Done && i > episode.stage1Index && spikeWithin6Days && decline2,
    );
    if (episode && stage2UpgradeEvent) {
      episode.stage2Done = true;
      episode.stage2Date = dateKey(row.t);
    }

    const activeEpisode = episode && i - episode.lastCandidateIndex <= episodeMergeDays ? episode : null;
    const stagedTargetPct: StagedTargetPct = activeEpisode ? (activeEpisode.stage2Done ? 100 : 60) : 0;
    const stagedAddedPct: StagedAddedPct = stage1EntryEvent ? 60 : stage2UpgradeEvent ? 40 : 0;

    out.push({
      t: row.t,
      spikeToday,
      spikeWithin6Days,
      spikePeakDate: spikePeakIndex >= 0 ? dateKey(rows[spikePeakIndex].t) : null,
      spikeDaysAgo: spikePeakIndex >= 0 ? i - spikePeakIndex : null,
      decline1,
      decline2,
      stage1EntryEvent,
      stage2UpgradeEvent,
      stageEpisodeId: activeEpisode?.id ?? null,
      stage1Date: activeEpisode?.stage1Date ?? null,
      stage2Date: activeEpisode?.stage2Date ?? null,
      stagedTargetPct,
      stagedAddedPct,
      officialS2: row.officialS2,
      officialStrong: Boolean(row.fear !== null && row.fear >= fearArm && row.s1 && row.officialS2 && row.s3),
    });
  }
  return out;
}

/**
 * 라이브 확인은 asOf 이후의 미국 데이터를 잘라낸 뒤 계산한다. 현재 티어가 켜져 있으면
 * 그 에피소드의 첫 점등일을, 꺼져 있으면 직전 21 미국 거래일의 에피소드 첫 점등만 본다.
 */
export function computeLiveUsConfirmation(
  timeline: UsTierPoint[],
  asOf: number | null,
  lookbackTradingDays = 21,
): LiveUsConfirmation {
  if (asOf === null) return { usTierNow: null, usConfirmedAsOfDate: null, usConfirmationLabel: "미국 확인 없음" };
  const visible = [...timeline].filter((p) => p.t <= asOf).sort((a, b) => a.t - b.t);
  if (visible.length === 0) return { usTierNow: null, usConfirmedAsOfDate: null, usConfirmationLabel: "미국 확인 없음" };

  const last = visible[visible.length - 1];
  let confirmed: UsTierPoint | null = null;
  if (last.tier !== null) {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].episodeStart) {
        confirmed = visible[i];
        break;
      }
    }
    confirmed ??= last;
  } else {
    const start = Math.max(0, visible.length - lookbackTradingDays);
    for (let i = visible.length - 1; i >= start; i--) {
      if (visible[i].episodeStart && visible[i].tier !== null) {
        confirmed = visible[i];
        break;
      }
    }
  }
  const tier = last.tier;
  const labelTier = tier ?? confirmed?.tier ?? null;
  const usConfirmationLabel: UsConfirmationLabel =
    labelTier === 0 ? "Tier0 확인" : labelTier === 1 ? "Tier1 확인" : labelTier === 2 ? "Tier2 확인" : "미국 확인 없음";
  return {
    usTierNow: tier,
    usConfirmedAsOfDate: confirmed ? dateKey(confirmed.t) : null,
    usConfirmationLabel,
  };
}

/** 과거 연구 전용: 한국 신호일을 중심으로 ±N 미국 거래일의 첫 점등 여부를 분류한다. */
export function hasUsConfirmationAround(
  timeline: UsTierPoint[],
  signalTime: number,
  windowTradingDays = 21,
): boolean {
  const rows = [...timeline].sort((a, b) => a.t - b.t);
  if (rows.length === 0) return false;
  const d = dayNumber(signalTime);
  let insertion = rows.findIndex((p) => dayNumber(p.t) >= d);
  if (insertion < 0) insertion = rows.length - 1;
  const lo = Math.max(0, insertion - windowTradingDays);
  const hi = Math.min(rows.length - 1, insertion + windowTradingDays);
  for (let i = lo; i <= hi; i++) if (rows[i].episodeStart && rows[i].tier !== null) return true;
  return false;
}

export const __test = { dateKey, dayNumber };
