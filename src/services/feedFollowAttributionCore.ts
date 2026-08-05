import type { DailyAddsBasis, FollowerDailyAddsPoint } from "./followerFlowCore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedAttributionPost {
  mediaId: string;
  mediaType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  baselineFollows: number | null;
  baselineCapturedAt: Date | null;
}

export interface FeedAttributionSnapshot {
  mediaId: string;
  day: Date;
  capturedAt: Date;
  follows: number | null;
  status: string;
}

export type FeedCollectionStatus = "not_started" | "complete" | "partial" | "missing";
export type FeedComparisonReason =
  | "feed_not_started"
  | "feed_tracking_partial_day"
  | "feed_collection_incomplete"
  | "feed_multi_day_delta"
  | "feed_counter_correction"
  | "account_missing"
  | "account_provisional"
  | "account_not_one_day";

export interface FeedAttributionPostDelta {
  mediaId: string;
  mediaType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: string | null;
  follows: number;
  delta: number;
  spanDays: number;
}

export interface FeedAttributionDay {
  day: string;
  collectionStatus: FeedCollectionStatus;
  eligiblePosts: number;
  successfulPosts: number;
  unavailablePosts: number;
  failedPosts: number;
  missingPosts: number;
  attributedFeedFollows: number | null;
  posts: FeedAttributionPostDelta[];
  hasCounterCorrection: boolean;
  hasMultiDayDelta: boolean;
  accountNetAdds: number | null;
  accountBasis: DailyAddsBasis | null;
  accountProvisional: boolean;
  netResidualAfterFeed: number | null;
  comparisonReason: FeedComparisonReason | null;
}

export interface FeedFollowAttribution {
  days: FeedAttributionDay[];
  summary: {
    comparableDays: number;
    attributedFeedFollows: number;
    accountNetAdds: number;
    netResidualAfterFeed: number;
  };
}

interface BuildAttributionInput {
  from: string;
  to: string;
  trackingStartedAt: Date | null;
  posts: FeedAttributionPost[];
  snapshots: FeedAttributionSnapshot[];
  followerPoints: FollowerDailyAddsPoint[];
}

interface CalculatedSnapshot {
  snapshot: FeedAttributionSnapshot;
  delta: number | null;
  spanDays: number | null;
}

function dayString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.round((dayNumber(to) - dayNumber(from)) / DAY_MS);
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let value = dayNumber(from); value <= dayNumber(to); value += DAY_MS) {
    days.push(new Date(value).toISOString().slice(0, 10));
  }
  return days;
}

function calculateSnapshots(
  post: FeedAttributionPost,
  snapshots: FeedAttributionSnapshot[],
  trackingStartedAt: Date | null,
): Map<string, CalculatedSnapshot> {
  let priorCount = post.baselineFollows;
  let priorDay = post.baselineCapturedAt ? dayString(post.baselineCapturedAt) : null;
  let firstSuccessfulReading = true;
  const usesPublicationBaseline =
    trackingStartedAt !== null && post.postedAt !== null && post.postedAt >= trackingStartedAt;
  const byDay = new Map<string, CalculatedSnapshot>();

  for (const snapshot of snapshots.sort((a, b) => a.day.getTime() - b.day.getTime())) {
    const day = dayString(snapshot.day);
    let delta: number | null = null;
    let spanDays: number | null = null;
    if (snapshot.status === "ok" && snapshot.follows !== null && priorCount !== null) {
      delta = snapshot.follows - priorCount;
      spanDays =
        priorDay === null
          ? 1
          : Math.max(
              1,
              calendarDaysBetween(priorDay, day) +
                (firstSuccessfulReading && usesPublicationBaseline ? 1 : 0),
            );
      priorCount = snapshot.follows;
      priorDay = day;
      firstSuccessfulReading = false;
    }
    byDay.set(day, { snapshot, delta, spanDays });
  }
  return byDay;
}

function comparisonReason(
  collectionStatus: FeedCollectionStatus,
  trackingPartialDay: boolean,
  hasMultiDayDelta: boolean,
  hasCounterCorrection: boolean,
  account: FollowerDailyAddsPoint | undefined,
): FeedComparisonReason | null {
  if (collectionStatus === "not_started") return "feed_not_started";
  if (trackingPartialDay) return "feed_tracking_partial_day";
  if (collectionStatus !== "complete") return "feed_collection_incomplete";
  if (hasMultiDayDelta) return "feed_multi_day_delta";
  if (hasCounterCorrection) return "feed_counter_correction";
  if (!account || account.total === null) return "account_missing";
  if (account.provisional) return "account_provisional";
  if (account.basis !== "diff" || account.spanDays !== 1) return "account_not_one_day";
  return null;
}

export function buildFeedFollowAttribution(input: BuildAttributionInput): FeedFollowAttribution {
  const snapshotsByPost = new Map<string, FeedAttributionSnapshot[]>();
  for (const snapshot of input.snapshots) {
    const current = snapshotsByPost.get(snapshot.mediaId) ?? [];
    current.push(snapshot);
    snapshotsByPost.set(snapshot.mediaId, current);
  }
  const calculatedByPost = new Map(
    input.posts.map((post) => [
      post.mediaId,
      calculateSnapshots(post, snapshotsByPost.get(post.mediaId) ?? [], input.trackingStartedAt),
    ]),
  );
  const followersByDay = new Map(input.followerPoints.map((point) => [point.day, point]));
  const trackingDay = input.trackingStartedAt ? dayString(input.trackingStartedAt) : null;

  const days = enumerateDays(input.from, input.to).map<FeedAttributionDay>((day) => {
    if (trackingDay === null || day < trackingDay) {
      const account = followersByDay.get(day);
      return {
        day,
        collectionStatus: "not_started",
        eligiblePosts: 0,
        successfulPosts: 0,
        unavailablePosts: 0,
        failedPosts: 0,
        missingPosts: 0,
        attributedFeedFollows: null,
        posts: [],
        hasCounterCorrection: false,
        hasMultiDayDelta: false,
        accountNetAdds: account?.total ?? null,
        accountBasis: account?.basis ?? null,
        accountProvisional: account?.provisional ?? false,
        netResidualAfterFeed: null,
        comparisonReason: "feed_not_started",
      };
    }

    const eligible = input.posts.filter((post) => {
      const publishedAfterTracking =
        input.trackingStartedAt !== null &&
        post.postedAt !== null &&
        post.postedAt >= input.trackingStartedAt;
      const eligibleFrom =
        publishedAfterTracking && post.postedAt
          ? dayString(post.postedAt)
          : dayString(post.firstSeenAt);
      return eligibleFrom <= day;
    });
    let successfulPosts = 0;
    let unavailablePosts = 0;
    let failedPosts = 0;
    let missingPosts = 0;
    let attributed = 0;
    let hasCounterCorrection = false;
    let hasMultiDayDelta = false;
    const contributors: FeedAttributionPostDelta[] = [];

    for (const post of eligible) {
      const calculated = calculatedByPost.get(post.mediaId)?.get(day);
      if (!calculated) {
        missingPosts++;
        continue;
      }
      if (calculated.snapshot.status === "unavailable") {
        unavailablePosts++;
        continue;
      }
      if (calculated.snapshot.status === "failed") {
        failedPosts++;
        continue;
      }
      if (
        calculated.snapshot.status !== "ok" ||
        calculated.snapshot.follows === null ||
        calculated.delta === null ||
        calculated.spanDays === null
      ) {
        missingPosts++;
        continue;
      }

      successfulPosts++;
      attributed += calculated.delta;
      if (calculated.delta < 0) hasCounterCorrection = true;
      if (calculated.spanDays > 1) hasMultiDayDelta = true;
      if (calculated.delta !== 0) {
        contributors.push({
          mediaId: post.mediaId,
          mediaType: post.mediaType,
          caption: post.caption,
          permalink: post.permalink,
          thumbnailUrl: post.thumbnailUrl,
          postedAt: post.postedAt?.toISOString() ?? null,
          follows: calculated.snapshot.follows,
          delta: calculated.delta,
          spanDays: calculated.spanDays,
        });
      }
    }

    let collectionStatus: FeedCollectionStatus =
      eligible.length > 0 && successfulPosts === eligible.length
        ? "complete"
        : successfulPosts > 0 || unavailablePosts > 0 || failedPosts > 0
          ? "partial"
          : "missing";
    // State creation never proves the first count was captured at 00:00:00, so
    // deployment day is always partial. Comparable windows start next UTC day.
    const trackingPartialDay = day === trackingDay;
    if (trackingPartialDay && collectionStatus === "complete") collectionStatus = "partial";
    const attributedFeedFollows = successfulPosts > 0 ? attributed : null;
    const account = followersByDay.get(day);
    const reason = comparisonReason(
      collectionStatus,
      trackingPartialDay,
      hasMultiDayDelta,
      hasCounterCorrection,
      account,
    );
    const netResidualAfterFeed =
      reason === null && attributedFeedFollows !== null && account !== undefined && account.total !== null
        ? account.total - attributedFeedFollows
        : null;

    return {
      day,
      collectionStatus,
      eligiblePosts: eligible.length,
      successfulPosts,
      unavailablePosts,
      failedPosts,
      missingPosts,
      attributedFeedFollows,
      posts: contributors.sort((a, b) => b.delta - a.delta),
      hasCounterCorrection,
      hasMultiDayDelta,
      accountNetAdds: account?.total ?? null,
      accountBasis: account?.basis ?? null,
      accountProvisional: account?.provisional ?? false,
      netResidualAfterFeed,
      comparisonReason: reason,
    };
  });

  const comparable = days.filter((day) => day.netResidualAfterFeed !== null);
  return {
    days,
    summary: {
      comparableDays: comparable.length,
      attributedFeedFollows: comparable.reduce(
        (sum, day) => sum + (day.attributedFeedFollows ?? 0),
        0,
      ),
      accountNetAdds: comparable.reduce((sum, day) => sum + (day.accountNetAdds ?? 0), 0),
      netResidualAfterFeed: comparable.reduce(
        (sum, day) => sum + (day.netResidualAfterFeed ?? 0),
        0,
      ),
    },
  };
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dayNumber(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function parseFeedFollowAttributionRange(
  query: { from?: unknown; to?: unknown },
  now = new Date(),
): { from: string; to: string } {
  const today = dayString(now);
  const to = query.to ?? today;
  if (!validDay(to)) throw new Error("invalid_date_range");
  const defaultFrom = new Date(dayNumber(to) - 29 * DAY_MS).toISOString().slice(0, 10);
  const from = query.from ?? defaultFrom;
  if (!validDay(from)) throw new Error("invalid_date_range");
  const span = calendarDaysBetween(from, to);
  if (span < 0 || span > 89) throw new Error("invalid_date_range");
  return { from, to };
}
