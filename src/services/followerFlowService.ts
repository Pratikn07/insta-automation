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

// DB-facing wrapper around the pure follower-flow core (followerFlowCore.ts) —
// all diff/gap/staleness semantics live there.

export interface FollowerFlowResult {
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
}

const LOOKBACK_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The follower-flow read model: one point per calendar day over the lookback,
 * plus the latest cumulative stock. Last snapshot of each UTC day is the anchor
 * — the first-of-day snapshot systematically still carries yesterday's vector.
 */
export async function getFollowerDailyAdds(): Promise<FollowerFlowResult> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS);

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

  // Last row per UTC day wins.
  const anchorsByDay = new Map<string, AnchorSnapshot>();
  for (const row of rows) {
    const day = row.capturedAt.toISOString().slice(0, 10);
    anchorsByDay.set(day, {
      day,
      capturedAt: row.capturedAt,
      counts: asCounts(row.counts),
      totalCounted: row.totalCounted,
    });
  }
  const anchors = [...anchorsByDay.values()];
  const { followersTotal } = await profileTotalsPromise;

  return {
    points: buildDailyPoints(anchors),
    stock:
      anchors.length > 0
        ? stockFrom(anchors[anchors.length - 1]!, followersTotal)
        : null,
  };
}
