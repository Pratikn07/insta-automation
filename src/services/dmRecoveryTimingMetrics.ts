import type { RecoveryTimingArm } from "./dmRecoveryTimingExperiment.js";

const HOUR_MS = 60 * 60 * 1_000;
const OUTCOME_HOURS = 48;
const OUTCOME_MS = OUTCOME_HOURS * HOUR_MS;
const LATE_SEND_ALLOWANCE_MS = 60_000;
const DEFAULT_MINIMUM_MATURED = 1_700;
const PRACTICAL_DIFFERENCE_POINTS = 2;
const SAFETY_DIFFERENCE_POINTS = 2;
const Z_95 = 1.959963984540054;

export type TimingDecision =
  | "collecting"
  | "exploratory"
  | "inconclusive"
  | "two_hour_wins"
  | "six_hour_wins"
  | "safety_review";

export interface ProportionComparison {
  differencePercentagePoints: number | null;
  confidenceInterval95: { low: number; high: number } | null;
  zScore: number | null;
  pValue: number | null;
}

export interface CompletionCandidate {
  keywordId: string;
  completedAt: Date;
}

export interface TimingMetricRow {
  id: string;
  igUserId: string;
  keywordId: string;
  timingArm: RecoveryTimingArm;
  acceptedAt: Date;
  eligibleAt: Date;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
  repliedAt: Date | null;
  seenAt: Date | null;
  seenReceivedAt: Date | null;
  engagedAt: Date | null;
  engagedReceivedAt: Date | null;
  suppressionReason: string | null;
  suppressedAt: Date | null;
  completionCandidates: CompletionCandidate[];
  confirmedDuplicateSend: boolean;
}

export interface TimingArmSummary {
  arm: RecoveryTimingArm;
  assigned: number;
  allocationPercent: number | null;
  matured: number;
  immature: number;
  completedWithin24h: number;
  completedWithin48h: number;
  completionRate24h: number | null;
  completionRate48h: number | null;
  repliedWithin24h: number;
  repliedWithin48h: number;
  seenBeforeEligibility: number;
  sent: number;
  attempted: number;
  suppressed: number;
  suppressionReasons: Record<string, number>;
  sendFailed: number;
  sendUncertain: number;
  sendExceptionRate: number | null;
  delayedSignalFalsePositives: number;
  delayedSignalFalsePositiveRate: number | null;
  reminderToReplyMinutesMedian: number | null;
  readEventCoveragePercent: number | null;
  lateSendCount: number;
  latenessMs: { p50: number | null; p95: number | null; max: number | null };
  cooldownSuppressions: number;
  duplicateAttemptCount: number;
  confirmedDuplicateSends: number;
}

export interface TimingAnalysisContext {
  isFullExperimentRange: boolean;
  enrollmentClosedAt: Date | null;
  minimumMaturedPerTimingArm?: number;
}

export interface RecoveryTimingMetrics {
  asOf: Date;
  indexFollowers: number;
  assignmentDriftFollowers: number;
  arms: Record<RecoveryTimingArm, TimingArmSummary>;
  comparison: ProportionComparison;
  treatmentControlComparisons: {
    twoHour: ProportionComparison;
    sixHour: ProportionComparison;
  };
  duplicateSafetyEvent: boolean;
  safety: {
    twoHourMateriallyWorse: boolean;
    sixHourMateriallyWorse: boolean;
    controlPointEstimateHarm: boolean;
    treatmentControlConfidenceHarm: boolean;
  };
  decision: TimingDecision;
}

type CalculateInput = {
  rows: TimingMetricRow[];
  asOf: Date;
  analysis: TimingAnalysisContext;
};

export function isMatured(acceptedAt: Date, asOf: Date): boolean {
  return (
    Number.isFinite(acceptedAt.getTime()) &&
    Number.isFinite(asOf.getTime()) &&
    asOf.getTime() - acceptedAt.getTime() >= OUTCOME_MS
  );
}

export function completedWithin(
  acceptedAt: Date,
  completedAt: Date | null,
  hours: number,
): boolean {
  if (!completedAt || !Number.isFinite(hours) || hours < 0) return false;
  const elapsed = completedAt.getTime() - acceptedAt.getTime();
  return elapsed >= 0 && elapsed <= hours * HOUR_MS;
}

function normalCdf(value: number): number {
  // Abramowitz-Stegun 7.1.26 approximation for erf, comfortably more precise
  // than the displayed experiment percentages.
  const x = value / Math.SQRT2;
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
    t;
  const erf = sign * (1 - polynomial * Math.exp(-absolute * absolute));
  return 0.5 * (1 + erf);
}

export function compareProportions(
  successesA: number,
  denominatorA: number,
  successesB: number,
  denominatorB: number,
): ProportionComparison {
  if (denominatorA <= 0 || denominatorB <= 0) {
    return {
      differencePercentagePoints: null,
      confidenceInterval95: null,
      zScore: null,
      pValue: null,
    };
  }

  const proportionA = successesA / denominatorA;
  const proportionB = successesB / denominatorB;
  const difference = proportionA - proportionB;
  const pooled = (successesA + successesB) / (denominatorA + denominatorB);
  const pooledError = Math.sqrt(
    pooled * (1 - pooled) * (1 / denominatorA + 1 / denominatorB),
  );
  const zScore = pooledError === 0 ? 0 : difference / pooledError;
  const pValue = Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(zScore)))));

  const unpooledError = Math.sqrt(
    (proportionA * (1 - proportionA)) / denominatorA +
      (proportionB * (1 - proportionB)) / denominatorB,
  );
  const margin = Z_95 * unpooledError;

  return {
    differencePercentagePoints: difference * 100,
    confidenceInterval95: {
      low: (difference - margin) * 100,
      high: (difference + margin) * 100,
    },
    zScore,
    pValue,
  };
}

function earliestCompletion(row: TimingMetricRow): Date | null {
  const candidates = row.completionCandidates
    .filter(
      (candidate) =>
        candidate.keywordId === row.keywordId &&
        candidate.completedAt.getTime() >= row.acceptedAt.getTime(),
    )
    .map((candidate) => candidate.completedAt);

  if (
    (row.suppressionReason === "completed" ||
      row.suppressionReason === "completed_elsewhere") &&
    row.suppressedAt &&
    row.suppressedAt >= row.acceptedAt
  ) {
    candidates.push(row.suppressedAt);
  }

  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function delayedSignalFalsePositive(row: TimingMetricRow): boolean {
  if (row.attempts <= 0 || !row.lastAttemptAt) return false;
  const dispatchAt = row.lastAttemptAt.getTime();
  const signals: Array<[Date | null, Date | null]> = [
    [row.seenAt, row.seenReceivedAt],
    [row.engagedAt, row.engagedReceivedAt],
  ];
  return signals.some(
    ([eventAt, receivedAt]) =>
      eventAt !== null &&
      receivedAt !== null &&
      eventAt.getTime() < dispatchAt &&
      receivedAt.getTime() > dispatchAt,
  );
}

function summarizeArm(
  arm: RecoveryTimingArm,
  rows: TimingMetricRow[],
  asOf: Date,
  totalFollowers: number,
): TimingArmSummary {
  const maturedRows = rows.filter((row) => isMatured(row.acceptedAt, asOf));
  const completions = new Map(rows.map((row) => [row.id, earliestCompletion(row)]));
  const completed24 = maturedRows.filter((row) =>
    completedWithin(row.acceptedAt, completions.get(row.id) ?? null, 24),
  ).length;
  const completed48 = maturedRows.filter((row) =>
    completedWithin(row.acceptedAt, completions.get(row.id) ?? null, 48),
  ).length;
  const replied24 = maturedRows.filter((row) =>
    completedWithin(row.acceptedAt, row.repliedAt, 24),
  ).length;
  const replied48 = maturedRows.filter((row) =>
    completedWithin(row.acceptedAt, row.repliedAt, 48),
  ).length;
  const attemptedRows = rows.filter((row) => row.attempts > 0);
  const sendFailed = rows.filter((row) => row.status === "send_failed").length;
  const sendUncertain = rows.filter((row) => row.status === "send_uncertain").length;
  const delayedSignals = attemptedRows.filter(delayedSignalFalsePositive).length;
  const suppressedRows = rows.filter((row) => row.status === "suppressed");
  const suppressionReasons: Record<string, number> = {};
  for (const row of suppressedRows) {
    const reason = row.suppressionReason ?? "unknown";
    suppressionReasons[reason] = (suppressionReasons[reason] ?? 0) + 1;
  }

  const sentRows = rows.filter((row) => row.sentAt !== null);
  const latenessValues = sentRows.map((row) =>
    Math.max(0, row.sentAt!.getTime() - row.eligibleAt.getTime()),
  );
  const replyMinutes = sentRows
    .filter((row) => row.repliedAt !== null && row.repliedAt >= row.sentAt!)
    .map((row) => (row.repliedAt!.getTime() - row.sentAt!.getTime()) / 60_000);

  return {
    arm,
    assigned: rows.length,
    allocationPercent: rate(rows.length, totalFollowers),
    matured: maturedRows.length,
    immature: rows.length - maturedRows.length,
    completedWithin24h: completed24,
    completedWithin48h: completed48,
    completionRate24h: rate(completed24, maturedRows.length),
    completionRate48h: rate(completed48, maturedRows.length),
    repliedWithin24h: replied24,
    repliedWithin48h: replied48,
    seenBeforeEligibility: rows.filter(
      (row) => row.seenAt !== null && row.seenAt <= row.eligibleAt,
    ).length,
    sent: sentRows.length,
    attempted: attemptedRows.length,
    suppressed: suppressedRows.length,
    suppressionReasons,
    sendFailed,
    sendUncertain,
    sendExceptionRate: rate(sendFailed + sendUncertain, attemptedRows.length),
    delayedSignalFalsePositives: delayedSignals,
    delayedSignalFalsePositiveRate: rate(delayedSignals, attemptedRows.length),
    reminderToReplyMinutesMedian: percentile(replyMinutes, 0.5),
    readEventCoveragePercent: rate(
      rows.filter((row) => row.seenAt !== null).length,
      rows.length,
    ),
    lateSendCount: latenessValues.filter(
      (lateness) => lateness > LATE_SEND_ALLOWANCE_MS,
    ).length,
    latenessMs: {
      p50: percentile(latenessValues, 0.5),
      p95: percentile(latenessValues, 0.95),
      max: latenessValues.length === 0 ? null : Math.max(...latenessValues),
    },
    cooldownSuppressions: suppressedRows.filter(
      (row) => row.suppressionReason === "person_cooldown",
    ).length,
    duplicateAttemptCount: rows.reduce(
      (total, row) => total + Math.max(0, row.attempts - 1),
      0,
    ),
    confirmedDuplicateSends: rows.filter((row) => row.confirmedDuplicateSend).length,
  };
}

function exceedsByMoreThanTwo(
  candidate: number | null,
  other: number | null,
): boolean {
  return (
    candidate !== null &&
    other !== null &&
    candidate - other > SAFETY_DIFFERENCE_POINTS
  );
}

function materiallyWorse(
  candidate: TimingArmSummary,
  other: TimingArmSummary,
): boolean {
  return (
    exceedsByMoreThanTwo(candidate.sendExceptionRate, other.sendExceptionRate) ||
    exceedsByMoreThanTwo(
      candidate.delayedSignalFalsePositiveRate,
      other.delayedSignalFalsePositiveRate,
    )
  );
}

function statisticallyWins(
  comparison: ProportionComparison,
  direction: "positive" | "negative",
): boolean {
  const difference = comparison.differencePercentagePoints;
  const interval = comparison.confidenceInterval95;
  if (difference === null || comparison.pValue === null || !interval) return false;
  if (comparison.pValue >= 0.05) return false;
  return direction === "positive"
    ? difference >= PRACTICAL_DIFFERENCE_POINTS && interval.low > 0
    : difference <= -PRACTICAL_DIFFERENCE_POINTS && interval.high < 0;
}

export function calculateRecoveryTimingMetrics(
  input: CalculateInput,
): RecoveryTimingMetrics {
  const groups = new Map<string, TimingMetricRow[]>();
  for (const row of input.rows) {
    const group = groups.get(row.igUserId) ?? [];
    group.push(row);
    groups.set(row.igUserId, group);
  }

  let assignmentDriftFollowers = 0;
  const indexRows: TimingMetricRow[] = [];
  for (const rows of groups.values()) {
    if (new Set(rows.map((row) => row.timingArm)).size > 1) {
      assignmentDriftFollowers++;
    }
    rows.sort(
      (a, b) =>
        a.acceptedAt.getTime() - b.acceptedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    indexRows.push(rows[0]!);
  }

  const rowsByArm = {
    two_hour: indexRows.filter((row) => row.timingArm === "two_hour"),
    six_hour: indexRows.filter((row) => row.timingArm === "six_hour"),
    no_reminder: indexRows.filter((row) => row.timingArm === "no_reminder"),
  };
  const arms = {
    two_hour: summarizeArm(
      "two_hour",
      rowsByArm.two_hour,
      input.asOf,
      indexRows.length,
    ),
    six_hour: summarizeArm(
      "six_hour",
      rowsByArm.six_hour,
      input.asOf,
      indexRows.length,
    ),
    no_reminder: summarizeArm(
      "no_reminder",
      rowsByArm.no_reminder,
      input.asOf,
      indexRows.length,
    ),
  } satisfies Record<RecoveryTimingArm, TimingArmSummary>;

  const comparison = compareProportions(
    arms.two_hour.completedWithin48h,
    arms.two_hour.matured,
    arms.six_hour.completedWithin48h,
    arms.six_hour.matured,
  );
  const twoControl = compareProportions(
    arms.two_hour.completedWithin48h,
    arms.two_hour.matured,
    arms.no_reminder.completedWithin48h,
    arms.no_reminder.matured,
  );
  const sixControl = compareProportions(
    arms.six_hour.completedWithin48h,
    arms.six_hour.matured,
    arms.no_reminder.completedWithin48h,
    arms.no_reminder.matured,
  );

  const duplicateSafetyEvent = Object.values(arms).some(
    (arm) => arm.confirmedDuplicateSends > 0,
  );
  const twoHourMateriallyWorse = materiallyWorse(arms.two_hour, arms.six_hour);
  const sixHourMateriallyWorse = materiallyWorse(arms.six_hour, arms.two_hour);
  const controlRate = arms.no_reminder.completionRate48h;
  const controlPointEstimateHarm =
    controlRate !== null &&
    arms.two_hour.completionRate48h !== null &&
    arms.six_hour.completionRate48h !== null &&
    controlRate - arms.two_hour.completionRate48h >= PRACTICAL_DIFFERENCE_POINTS &&
    controlRate - arms.six_hour.completionRate48h >= PRACTICAL_DIFFERENCE_POINTS;
  const treatmentControlConfidenceHarm = [twoControl, sixControl].some(
    (candidate) =>
      candidate.confidenceInterval95 !== null &&
      candidate.confidenceInterval95.high < 0,
  );

  const minimumMatured =
    input.analysis.minimumMaturedPerTimingArm ?? DEFAULT_MINIMUM_MATURED;
  let decision: TimingDecision;
  if (assignmentDriftFollowers > 0 || duplicateSafetyEvent) {
    decision = "safety_review";
  } else if (!input.analysis.isFullExperimentRange) {
    decision = "exploratory";
  } else if (input.analysis.enrollmentClosedAt === null) {
    decision = "collecting";
  } else if (
    input.asOf.getTime() - input.analysis.enrollmentClosedAt.getTime() <
    OUTCOME_MS
  ) {
    decision = "collecting";
  } else if (
    arms.two_hour.matured < minimumMatured ||
    arms.six_hour.matured < minimumMatured
  ) {
    decision = "inconclusive";
  } else if (
    controlPointEstimateHarm ||
    treatmentControlConfidenceHarm ||
    twoHourMateriallyWorse ||
    sixHourMateriallyWorse
  ) {
    decision = "safety_review";
  } else if (statisticallyWins(comparison, "positive")) {
    decision = "two_hour_wins";
  } else if (statisticallyWins(comparison, "negative")) {
    decision = "six_hour_wins";
  } else {
    decision = "inconclusive";
  }

  return {
    asOf: new Date(input.asOf.getTime()),
    indexFollowers: indexRows.length,
    assignmentDriftFollowers,
    arms,
    comparison,
    treatmentControlComparisons: {
      twoHour: twoControl,
      sixHour: sixControl,
    },
    duplicateSafetyEvent,
    safety: {
      twoHourMateriallyWorse,
      sixHourMateriallyWorse,
      controlPointEstimateHarm,
      treatmentControlConfidenceHarm,
    },
    decision,
  };
}
