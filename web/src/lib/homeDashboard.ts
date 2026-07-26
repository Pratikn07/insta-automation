import type { FollowConversion, GeoWindowPoint, LeaderboardRow } from "./types";

export type AudienceGrowthStatus = "growing" | "steady" | "cooling";
export type AudienceGrowthSource = "reached" | "engaged";
export type RepeatReasonKey = "reach" | "retention" | "guides";

export interface AudienceGrowthSummary {
  status: AudienceGrowthStatus;
  source: AudienceGrowthSource;
  currentPct: number;
  baselinePct: number;
  deltaPoints: number;
  capturedAt: string;
  latestPoint: GeoWindowPoint;
}

export interface RepeatCandidate extends LeaderboardRow {
  rank: number;
  score: number;
  reasonKey: RepeatReasonKey;
  reason: string;
  signals: {
    reach: number;
    retention: number;
    guides: number;
  };
}

const GROWTH_THRESHOLD_POINTS = 2;
const REPEAT_LIMIT = 3;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function comparisonFromPoint(point: GeoWindowPoint): {
  source: AudienceGrowthSource;
  currentPct: number;
  baselinePct: number;
} | null {
  if (isNumber(point.reachedUs14) && isNumber(point.reachedUs90)) {
    return { source: "reached", currentPct: point.reachedUs14, baselinePct: point.reachedUs90 };
  }
  if (isNumber(point.engagedUs14) && isNumber(point.engagedUs90)) {
    return { source: "engaged", currentPct: point.engagedUs14, baselinePct: point.engagedUs90 };
  }
  return null;
}

export function summarizeAudienceGrowth(points: GeoWindowPoint[]): AudienceGrowthSummary | null {
  const ordered = [...points].sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
  );

  for (const point of ordered) {
    const comparison = comparisonFromPoint(point);
    if (!comparison) continue;

    const deltaPoints = round(comparison.currentPct - comparison.baselinePct);
    const status: AudienceGrowthStatus =
      deltaPoints >= GROWTH_THRESHOLD_POINTS
        ? "growing"
        : deltaPoints <= -GROWTH_THRESHOLD_POINTS
          ? "cooling"
          : "steady";

    return {
      ...comparison,
      status,
      deltaPoints,
      capturedAt: point.capturedAt,
      latestPoint: point,
    };
  }

  return null;
}

export function formatAudienceDelta(deltaPoints: number): string {
  const absolute = Math.abs(deltaPoints).toFixed(1);
  const sign = deltaPoints > 0 ? "+" : deltaPoints < 0 ? "−" : "";
  return `${sign}${absolute} percentage points`;
}

export interface FreshnessSummary {
  label: string; // "as of Jul 19 · 6 days old"
  daysOld: number;
  isStale: boolean;
}

/**
 * How old a feed's newest data is. `now` is a parameter (never Date.now())
 * so this stays pure like everything else in this file. The reached/engaged
 * geo feed normally refreshes every 3-4 days, hence the default threshold.
 */
export function describeFreshness(
  capturedAt: string,
  now: string,
  staleAfterDays = 3,
): FreshnessSummary | null {
  const captured = new Date(capturedAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(captured) || !Number.isFinite(current)) return null;

  const daysOld = Math.max(0, Math.floor((current - captured) / (24 * 60 * 60 * 1000)));
  const dateLabel = new Date(capturedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return {
    label: `as of ${dateLabel} · ${daysOld} day${daysOld === 1 ? "" : "s"} old`,
    daysOld,
    isStale: daysOld >= staleAfterDays,
  };
}

export type FollowerYieldState = "empty" | "measured";

export interface FollowerYieldSummary {
  state: FollowerYieldState;
  windowDays: number;
  converted: number;
  rechecked: number;
  pending: number;
  yieldPct: number | null;
  headline: string;
}

/**
 * Turn the backend follow-conversion block into a display-ready summary. The
 * yield is a lower bound (single recheck ~3 days after delivery) and describes
 * "followed within the window", not causation — the copy stays honest about that.
 * `empty` until at least one recipient has been rechecked.
 */
export function summarizeFollowerYield(
  data: FollowConversion | null | undefined,
): FollowerYieldSummary | null {
  if (!data) return null;

  const { windowDays, rechecked, converted, pending } = data;
  const base = { windowDays, converted, rechecked, pending, yieldPct: data.yieldPct };

  if (rechecked <= 0) {
    return {
      ...base,
      state: "empty",
      yieldPct: null,
      headline:
        pending > 0
          ? `Measuring ${pending} recent non-follower${pending === 1 ? "" : "s"} — results unlock a few days after delivery`
          : "No non-follower deliveries to measure yet",
    };
  }

  const pct = data.yieldPct ?? round((converted / rechecked) * 100);
  return {
    ...base,
    state: "measured",
    yieldPct: pct,
    headline: `${converted} of ${rechecked} non-followers followed after getting their guide`,
  };
}

function percentile(values: number[], value: number): number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length <= 1) return 1;
  const index = sorted.indexOf(value);
  return index < 0 ? 0 : index / (sorted.length - 1);
}

function measured(reel: LeaderboardRow): boolean {
  return isNumber(reel.reach) || isNumber(reel.skipRate) || reel.conversion.completed > 0;
}

function chooseReason(signals: RepeatCandidate["signals"]): RepeatReasonKey {
  if (signals.guides > signals.reach && signals.guides > signals.retention) return "guides";
  if (signals.retention > signals.reach) return "retention";
  return "reach";
}

const REASONS: Record<RepeatReasonKey, string> = {
  reach: "One of your strongest reels for reaching people.",
  retention: "People kept watching instead of skipping.",
  guides: "It turned attention into guide deliveries.",
};

export function rankRepeatCandidates(reels: LeaderboardRow[]): RepeatCandidate[] {
  const eligible = reels.filter(measured);
  if (eligible.length === 0) return [];

  const reaches = eligible.flatMap((reel) => (isNumber(reel.reach) ? [reel.reach] : []));
  const retentions = eligible.flatMap((reel) =>
    isNumber(reel.skipRate) ? [1 - reel.skipRate] : [],
  );
  const guides = eligible.map((reel) => reel.conversion.completed);

  return eligible
    .map((reel) => {
      const signals = {
        reach: isNumber(reel.reach) ? percentile(reaches, reel.reach) : 0,
        retention: isNumber(reel.skipRate)
          ? percentile(retentions, 1 - reel.skipRate)
          : 0,
        guides: reel.conversion.completed > 0
          ? percentile(guides, reel.conversion.completed)
          : 0,
      };
      const reasonKey = chooseReason(signals);
      const score = round(signals.reach * 50 + signals.retention * 30 + signals.guides * 20);

      return {
        ...reel,
        rank: 0,
        score,
        reasonKey,
        reason: REASONS[reasonKey],
        signals,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const postedB = b.postedAt ? new Date(b.postedAt).getTime() : 0;
      const postedA = a.postedAt ? new Date(a.postedAt).getTime() : 0;
      return postedB - postedA;
    })
    .slice(0, REPEAT_LIMIT)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
