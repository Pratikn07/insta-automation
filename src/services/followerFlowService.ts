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
import { dayKeyToSqlDate, sqlDateToDayKey } from "./analyticsDay.js";
import {
  allocateDailyPoints,
  exactNetAddsByDay,
  padPointsThrough,
  type AllocatedDailyAddsPoint,
  type TotalAnchor,
} from "./followerAllocationCore.js";

// DB-facing wrapper around the pure follower-flow core (followerFlowCore.ts) —
// all diff/gap/staleness semantics live there.

/**
 * A chart point with Meta's follow/unfollow ledger attached where it has one.
 *
 * Kept separate from the allocation core's shape because it answers a different
 * question. `total` is NET — a day that gained 400 and lost 380 looks identical
 * to one that gained 20 — and no amount of arithmetic on followers_count can
 * recover the two sides. Only `follows_and_unfollows` reports them, and only for
 * the days Meta chooses to answer, so both fields are independently nullable.
 */
export interface FollowerFlowPoint extends AllocatedDailyAddsPoint {
  follows: number | null;
  unfollows: number | null;
}

export interface FollowerFlowResult {
  analyticsTimeZone: typeof ANALYTICS_TIME_ZONE;
  points: FollowerFlowPoint[];
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

interface ChurnRow {
  day: Date;
  follows: number | null;
  unfollows: number | null;
}

/**
 * Attach the follow/unfollow ledger to the days that have one.
 *
 * A day with no row, or a row Meta declined to fill, carries nulls rather than
 * zeroes: "no unfollows" and "we do not know" must not render the same way.
 */
function withChurn(
  points: AllocatedDailyAddsPoint[],
  churnRows: ChurnRow[],
): FollowerFlowPoint[] {
  const byDay = new Map(churnRows.map((row) => [sqlDateToDayKey(row.day), row]));
  return points.map((point) => {
    const churn = byDay.get(point.day);
    return {
      ...point,
      follows: churn?.follows ?? null,
      unfollows: churn?.unfollows ?? null,
    };
  });
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
}): Promise<FollowerFlowPoint[]> {
  const toSuccessorExclusive = analyticsDayBounds(shiftDayKey(range.to, 3)).start;
  const [rows, totalRows, churnRows] = await Promise.all([
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
    prisma.followerChurnDaySnapshot.findMany({
      where: {
        status: "ok",
        day: { gte: dayKeyToSqlDate(range.from), lte: dayKeyToSqlDate(range.to) },
      },
      select: { day: true, follows: true, unfollows: true },
    }),
  ]);
  return withChurn(
    anchorToExactTotals(buildDailyPoints(anchorsFromRows(rows)), totalRows),
    churnRows,
  ).filter((point) => point.day >= range.from && point.day <= range.to);
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

  const [rows, totalRows, churnRows] = await Promise.all([
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
    prisma.followerChurnDaySnapshot.findMany({
      where: { status: "ok", day: { gte: dayKeyToSqlDate(shiftDayKey(today, -LOOKBACK_DAYS)) } },
      select: { day: true, follows: true, unfollows: true },
    }),
  ]);

  // Last row per Pacific analytics day wins.
  const anchors = anchorsFromRows(rows);
  const points = withChurn(anchorToExactTotals(buildDailyPoints(anchors), totalRows), churnRows);

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
