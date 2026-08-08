import { prisma } from "../lib/prisma.js";
import { fetchProfileTotals } from "../meta/profileFetcher.js";
import {
  asCounts,
  buildDailyPoints,
  stockFrom,
  type AnchorSnapshot,
  type FollowerDailyAddsPoint,
  type FollowerStock,
} from "./followerFlowCore.js";
import {
  ANALYTICS_TIME_ZONE,
  analyticsDayBounds,
  shiftDayKey,
  toAnalyticsDayKey,
} from "./analyticsDay.js";
import { getSpikesByDay } from "./spikeService.js";

// DB-facing wrapper around the pure follower-flow core (followerFlowCore.ts) —
// all diff/gap/staleness semantics live there.

export interface FollowerFlowResult {
  analyticsTimeZone: typeof ANALYTICS_TIME_ZONE;
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
}

const LOOKBACK_DAYS = 90;

interface FollowerSnapshotRow {
  capturedAt: Date;
  counts: unknown;
  totalCounted: number | null;
}

function anchorsFromRows(rows: FollowerSnapshotRow[]): AnchorSnapshot[] {
  const anchorsByDay = new Map<string, AnchorSnapshot>();
  for (const row of rows) {
    const day = toAnalyticsDayKey(row.capturedAt);
    anchorsByDay.set(day, {
      day,
      capturedAt: row.capturedAt,
      counts: asCounts(row.counts),
      totalCounted: row.totalCounted,
    });
  }
  return [...anchorsByDay.values()];
}

/**
 * Stored net-add points for an explicit range. Reads all predecessor anchors so
 * the first requested day has a real diff, plus two successor days so an old
 * range is not incorrectly marked provisional merely because the query stopped.
 */
export async function getFollowerDailyAddsPointsForRange(range: {
  from: string;
  to: string;
}): Promise<FollowerDailyAddsPoint[]> {
  const toSuccessorExclusive = analyticsDayBounds(shiftDayKey(range.to, 3)).start;
  const rows = await prisma.geoDemographicSnapshot.findMany({
    where: { stage: "follower", capturedAt: { lt: toSuccessorExclusive } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, counts: true, totalCounted: true },
  });
  return buildDailyPoints(anchorsFromRows(rows)).filter(
    (point) => point.day >= range.from && point.day <= range.to,
  );
}

/**
 * The follower-flow read model: one point per Pacific analytics day over the lookback,
 * plus the latest cumulative stock. Last snapshot of each Pacific analytics day is the anchor
 * — the first-of-day snapshot systematically still carries yesterday's vector.
 */
export async function getFollowerDailyAdds(): Promise<FollowerFlowResult> {
  const today = toAnalyticsDayKey(new Date());
  const cutoff = analyticsDayBounds(shiftDayKey(today, -LOOKBACK_DAYS)).start;

  // Kick off the profile fetch before awaiting the DB read — it's an independent
  // network call, so serializing them would add its latency for nothing. Fetched
  // per request rather than stored, so the headline can never drift from what
  // Instagram shows on the profile.
  const profileTotalsPromise = fetchProfileTotals();

  const rows = await prisma.geoDemographicSnapshot.findMany({
    where: { stage: "follower", capturedAt: { gte: cutoff } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, counts: true, totalCounted: true },
  });

  // Last row per Pacific analytics day wins.
  const anchors = anchorsFromRows(rows);
  const points = buildDailyPoints(anchors);

  // Spike attribution needs the finished points, so it can only start here.
  const spikesByDay = await getSpikesByDay(points);
  for (const point of points) {
    const spike = spikesByDay.get(point.day);
    if (spike) point.spike = spike;
  }

  const { followersTotal } = await profileTotalsPromise;

  return {
    analyticsTimeZone: ANALYTICS_TIME_ZONE,
    points,
    stock:
      anchors.length > 0
        ? stockFrom(anchors[anchors.length - 1]!, followersTotal)
        : null,
  };
}
