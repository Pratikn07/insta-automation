import {
  analyticsDayBounds,
  isDayKey,
  shiftDayKey,
  toAnalyticsDayKey,
} from "./analyticsDay.js";

const HOUR_MS = 60 * 60 * 1_000;
const OUTCOME_WINDOW_MS = 48 * HOUR_MS;

export const RECOVERY_REPORTING_PRESETS = ["7d", "14d", "30d", "all"] as const;
export type RecoveryReportingPreset = (typeof RECOVERY_REPORTING_PRESETS)[number];

export type RecoveryDayRange = {
  from: string;
  to: string;
};

export type RecoveryRangeRequest =
  | { preset: RecoveryReportingPreset }
  | RecoveryDayRange;

export type RecoveryReportingWindow = {
  coverage: RecoveryDayRange | null;
  requestedRange: RecoveryDayRange | null;
  effectiveRange: RecoveryDayRange | null;
  acceptedAt: { gte: Date; lt: Date } | null;
  asOf: Date;
  maturityCutoff: Date;
  resultsCompleteThrough: string | null;
  isFullCoverage: boolean;
  empty: boolean;
};

type ResolveRecoveryReportingWindowInput = {
  coverage: RecoveryDayRange | null;
  requested: RecoveryRangeRequest | null;
  asOf: Date;
  /** Injectable server clock for deterministic validation tests. */
  now?: Date;
};

function fail(code: string): never {
  throw new Error(code);
}

function validRange(range: RecoveryDayRange): boolean {
  return isDayKey(range.from) && isDayKey(range.to) && range.from <= range.to;
}

function requestedRange(
  coverage: RecoveryDayRange,
  requested: RecoveryRangeRequest | null,
): RecoveryDayRange {
  if (!requested) {
    return { from: shiftDayKey(coverage.to, -29), to: coverage.to };
  }

  if ("preset" in requested) {
    if (requested.preset === "all") return { ...coverage };
    const days = Number.parseInt(requested.preset, 10);
    if (![7, 14, 30].includes(days)) return fail("invalid_date_range");
    return { from: shiftDayKey(coverage.to, -(days - 1)), to: coverage.to };
  }

  if (!validRange(requested)) return fail("invalid_date_range");
  return { ...requested };
}

function completeThrough(
  effectiveRange: RecoveryDayRange,
  maturityCutoff: Date,
): string | null {
  // The day containing the cutoff is still in progress. Move by a calendar
  // day, not 24 hours, so spring-forward and fall-back remain correct.
  const lastFullDay = shiftDayKey(toAnalyticsDayKey(maturityCutoff), -1);
  const candidate =
    lastFullDay < effectiveRange.to ? lastFullDay : effectiveRange.to;

  if (candidate < effectiveRange.from) return null;
  // Defensive boundary assertion. analyticsDayBounds owns the timezone logic.
  return analyticsDayBounds(candidate).endExclusive <= maturityCutoff
    ? candidate
    : null;
}

export function resolveRecoveryReportingWindow(
  input: ResolveRecoveryReportingWindowInput,
): RecoveryReportingWindow {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.asOf.getTime()) || !Number.isFinite(now.getTime())) {
    return fail("invalid_as_of");
  }
  if (input.asOf > now) return fail("future_as_of");

  const asOf = new Date(input.asOf.getTime());
  const maturityCutoff = new Date(asOf.getTime() - OUTCOME_WINDOW_MS);

  if (input.coverage === null) {
    return {
      coverage: null,
      requestedRange: null,
      effectiveRange: null,
      acceptedAt: null,
      asOf,
      maturityCutoff,
      resultsCompleteThrough: null,
      isFullCoverage: true,
      empty: true,
    };
  }

  if (!validRange(input.coverage)) return fail("invalid_coverage");
  const coverage = { ...input.coverage };
  const requested = requestedRange(coverage, input.requested);
  const effectiveRange = {
    from: requested.from < coverage.from ? coverage.from : requested.from,
    to: requested.to > coverage.to ? coverage.to : requested.to,
  };

  if (effectiveRange.from > effectiveRange.to) {
    return fail("range_outside_coverage");
  }

  const start = analyticsDayBounds(effectiveRange.from).start;
  const endExclusive = analyticsDayBounds(effectiveRange.to).endExclusive;

  return {
    coverage,
    requestedRange: requested,
    effectiveRange,
    acceptedAt: { gte: start, lt: endExclusive },
    asOf,
    maturityCutoff,
    resultsCompleteThrough: completeThrough(effectiveRange, maturityCutoff),
    isFullCoverage:
      effectiveRange.from === coverage.from && effectiveRange.to === coverage.to,
    empty: false,
  };
}
