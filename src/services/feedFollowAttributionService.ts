import { prisma } from "../lib/prisma.js";
import { getFollowerDailyAddsPointsForRange } from "./followerFlowService.js";
import { analyticsDayBounds, dayKeyToSqlDate, sqlDateToDayKey } from "./analyticsDay.js";
import {
  buildFeedFollowAttribution,
  type FeedAttributionPost,
  type FeedAttributionSnapshot,
  type FeedFollowAttribution,
} from "./feedFollowAttributionCore.js";

export interface FeedFollowAttributionResponse extends FeedFollowAttribution {
  range: { from: string; to: string };
  tracking: {
    startedAt: string | null;
    lastAttemptAt: string | null;
    lastCompletedAt: string | null;
    lastStatus: string | null;
    eligibleCount: number;
    writtenCount: number;
    unavailableCount: number;
    failedCount: number;
    lastError: string | null;
    trackedPosts: number;
    latestSnapshotDay: string | null;
  };
  caveats: string[];
}

/** Read the stored attribution evidence and align it with the existing net-add series. */
export async function getFeedFollowAttribution(range: {
  from: string;
  to: string;
}): Promise<FeedFollowAttributionResponse> {
  const toDay = dayKeyToSqlDate(range.to);
  const toExclusive = analyticsDayBounds(range.to).endExclusive;

  const state = await prisma.feedFollowCollectorState.findUnique({
    where: { scope: "feed" },
  });
  const posts = await prisma.feedPostMeta.findMany({
    // A post can be published inside the requested range but first discovered
    // by the collector later. Include it by publication time so the core can
    // report that earlier day as missing instead of silently dropping it.
    where: {
      OR: [
        { firstSeenAt: { lt: toExclusive } },
        { postedAt: { lt: toExclusive } },
      ],
    },
    orderBy: { firstSeenAt: "asc" },
    select: {
      mediaId: true,
      mediaType: true,
      caption: true,
      permalink: true,
      thumbnailUrl: true,
      postedAt: true,
      firstSeenAt: true,
      baselineFollows: true,
      baselineCapturedAt: true,
    },
  });
  // Include the most recent successful evidence before `from`; cumulative
  // counters need that earlier value to derive the first requested day's delta.
  const snapshots = await prisma.feedFollowDailySnapshot.findMany({
    where: { day: { lte: toDay } },
    orderBy: [{ day: "asc" }, { mediaId: "asc" }],
    select: {
      mediaId: true,
      day: true,
      capturedAt: true,
      follows: true,
      status: true,
    },
  });
  const followerPoints = await getFollowerDailyAddsPointsForRange(range);

  const attribution = buildFeedFollowAttribution({
    ...range,
    trackingStartedAt: state?.startedAt ?? null,
    posts: posts as FeedAttributionPost[],
    snapshots: snapshots as FeedAttributionSnapshot[],
    followerPoints,
  });
  const latestSnapshot = snapshots.at(-1);

  return {
    range,
    tracking: {
      startedAt: state?.startedAt.toISOString() ?? null,
      lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
      lastCompletedAt: state?.lastCompletedAt?.toISOString() ?? null,
      lastStatus: state?.lastStatus ?? null,
      eligibleCount: state?.eligibleCount ?? 0,
      writtenCount: state?.writtenCount ?? 0,
      unavailableCount: state?.unavailableCount ?? 0,
      failedCount: state?.failedCount ?? 0,
      lastError: state?.lastError ?? null,
      trackedPosts: posts.length,
      latestSnapshotDay: latestSnapshot ? sqlDateToDayKey(latestSnapshot.day) : null,
    },
    ...attribution,
    caveats: [
      "Feed-attributed follows are gross follows credited by Meta to regular feed posts.",
      "Account daily adds are net follows minus unfollows and can lag by about 48 hours.",
      "netResidualAfterFeed is directional diagnostic evidence, not an exact unattributed-follower count.",
    ],
  };
}
