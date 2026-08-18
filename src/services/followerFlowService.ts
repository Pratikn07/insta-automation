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
import {
  allocateDailyPoints,
  exactNetAddsByDay,
  padPointsThrough,
  type AllocatedDailyAddsPoint,
  type TotalAnchor,
} from "./followerAllocationCore.js";

// DB-facing wrapper around the pure follower-flow core (followerFlowCore.ts) —
// all diff/gap/staleness semantics live there.

export interface FollowerFlowResult {
  analyticsTimeZone: typeof ANALYTICS_TIME_ZONE;
  points: AllocatedDailyAddsPoint[];
  stock: FollowerStock | null;
}

const LOOKBACK_DAYS = 90;

interface FollowerSnapshotRow {
  capturedAt: Date;
  counts: unknown;
  totalCounted: number | null;
}

interface FollowerTotalRow {
  capturedAt: Date;
  followersTotal: number;
}

/**
 * Last followers_count reading of each Pacific analytics day.
 *
 * Same last-of-day rule the demographic anchors use, for the same reason: an
 * early-morning capture still describes yesterday's growth, so diffing
 * first-of-day readings would shift every bar by one snapshot interval.
 */
function totalAnchorsFromRows(rows: FollowerTotalRow[]): TotalAnchor[] {
  const byDay = new Map<string, TotalAnchor>();
  for (const row of rows) {
    const day = toAnalyticsDayKey(row.capturedAt);
    byDay.set(day, { day, capturedAt: row.capturedAt, followersTotal: row.followersTotal });
  }
  return [...byDay.values()];
}

/**
 * Anchor the honest demographic points onto exact followers_count totals.
 *
 * Shared by both read paths so a filtered range can never disagree with the
 * chart it was filtered out of. Before the first followers_count capture there
 * is nothing to anchor to and the points pass through unchanged — historical
 * bars keep reading exactly as they always have.
 */
function anchorToExactTotals(
  measured: FollowerDailyAddsPoint[],
  totalRows: FollowerTotalRow[],
): AllocatedDailyAddsPoint[] {
  const totalAnchors = totalAnchorsFromRows(totalRows);
  const newestExactDay = totalAnchors[totalAnchors.length - 1]?.day;
  const padded = newestExactDay ? padPointsThrough(measured, newestExactDay) : measured;
  return allocateDailyPoints(padded, exactNetAddsByDay(totalAnchors));
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
}): Promise<AllocatedDailyAddsPoint[]> {
  const toSuccessorExclusive = analyticsDayBounds(shiftDayKey(range.to, 3)).start;
  const [rows, totalRows] = await Promise.all([
    prisma.geoDemographicSnapshot.findMany({
      where: { stage: "follower", capturedAt: { lt: toSuccessorExclusive } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, counts: true, totalCounted: true },
    }),
    prisma.followerTotalSnapshot.findMany({
      where: { capturedAt: { lt: toSuccessorExclusive } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, followersTotal: true },
    }),
  ]);
  return anchorToExactTotals(buildDailyPoints(anchorsFromRows(rows)), totalRows).filter(
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

  const [rows, totalRows] = await Promise.all([
    prisma.geoDemographicSnapshot.findMany({
      where: { stage: "follower", capturedAt: { gte: cutoff } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, counts: true, totalCounted: true },
    }),
    prisma.followerTotalSnapshot.findMany({
      where: { capturedAt: { gte: cutoff } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, followersTotal: true },
    }),
  ]);

  // Last row per Pacific analytics day wins.
  const anchors = anchorsFromRows(rows);
  const points = anchorToExactTotals(buildDailyPoints(anchors), totalRows);

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
