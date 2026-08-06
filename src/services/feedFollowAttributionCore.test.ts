import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";
import {
  buildFeedFollowAttribution,
  parseFeedFollowAttributionRange,
  type FeedAttributionPost,
  type FeedAttributionSnapshot,
} from "./feedFollowAttributionCore.js";

function followerPoint(
  day: string,
  total: number | null,
  overrides: Partial<FollowerDailyAddsPoint> = {},
): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: `${day}T12:00:00.000Z`,
    us: total,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
    ...overrides,
  };
}

function post(overrides: Partial<FeedAttributionPost> = {}): FeedAttributionPost {
  return {
    mediaId: "post-1",
    mediaType: "CAROUSEL_ALBUM",
    caption: "A useful carousel",
    permalink: "https://instagram.com/p/post-1",
    thumbnailUrl: "https://example.com/post-1.jpg",
    postedAt: new Date("2026-07-01T12:00:00Z"),
    firstSeenAt: new Date("2026-08-01T10:00:00Z"),
    baselineFollows: 5,
    baselineCapturedAt: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  };
}

function snapshot(
  day: string,
  follows: number | null,
  status: "ok" | "unavailable" | "failed" = "ok",
  mediaId = "post-1",
): FeedAttributionSnapshot {
  return {
    mediaId,
    day: new Date(`${day}T00:00:00Z`),
    capturedAt: new Date(`${day}T18:00:00Z`),
    follows,
    status,
  };
}

describe("buildFeedFollowAttribution", () => {
  it("calculates daily post deltas and a directional residual on comparable settled days", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-03",
      trackingStartedAt: new Date("2026-08-01T10:00:00Z"),
      posts: [post()],
      snapshots: [snapshot("2026-08-01", 5), snapshot("2026-08-02", 8), snapshot("2026-08-03", 9)],
      followerPoints: [followerPoint("2026-08-02", 5), followerPoint("2026-08-03", 2)],
    });

    expect(response.days).toEqual([
      {
        day: "2026-08-02",
        collectionStatus: "complete",
        eligiblePosts: 1,
        successfulPosts: 1,
        unavailablePosts: 0,
        failedPosts: 0,
        missingPosts: 0,
        attributedFeedFollows: 3,
        posts: [
          {
            mediaId: "post-1",
            mediaType: "CAROUSEL_ALBUM",
            caption: "A useful carousel",
            permalink: "https://instagram.com/p/post-1",
            thumbnailUrl: "https://example.com/post-1.jpg",
            postedAt: "2026-07-01T12:00:00.000Z",
            follows: 8,
            delta: 3,
            spanDays: 1,
          },
        ],
        hasCounterCorrection: false,
        hasMultiDayDelta: false,
        accountNetAdds: 5,
        accountBasis: "diff",
        accountProvisional: false,
        netResidualAfterFeed: 2,
        comparisonReason: null,
      },
      {
        day: "2026-08-03",
        collectionStatus: "complete",
        eligiblePosts: 1,
        successfulPosts: 1,
        unavailablePosts: 0,
        failedPosts: 0,
        missingPosts: 0,
        attributedFeedFollows: 1,
        posts: [
          {
            mediaId: "post-1",
            mediaType: "CAROUSEL_ALBUM",
            caption: "A useful carousel",
            permalink: "https://instagram.com/p/post-1",
            thumbnailUrl: "https://example.com/post-1.jpg",
            postedAt: "2026-07-01T12:00:00.000Z",
            follows: 9,
            delta: 1,
            spanDays: 1,
          },
        ],
        hasCounterCorrection: false,
        hasMultiDayDelta: false,
        accountNetAdds: 2,
        accountBasis: "diff",
        accountProvisional: false,
        netResidualAfterFeed: 1,
        comparisonReason: null,
      },
    ]);
    expect(response.summary).toEqual({
      comparableDays: 2,
      attributedFeedFollows: 4,
      accountNetAdds: 7,
      netResidualAfterFeed: 3,
    });
  });

  it("withholds the residual when feed collection is incomplete", () => {
    const second = post({ mediaId: "post-2", baselineFollows: 1 });
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-02",
      trackingStartedAt: new Date("2026-08-01T10:00:00Z"),
      posts: [post(), second],
      snapshots: [
        snapshot("2026-08-01", 5),
        snapshot("2026-08-01", 1, "ok", "post-2"),
        snapshot("2026-08-02", 8),
        snapshot("2026-08-02", null, "failed", "post-2"),
      ],
      followerPoints: [followerPoint("2026-08-02", 5)],
    });

    expect(response.days[0]).toMatchObject({
      collectionStatus: "partial",
      attributedFeedFollows: 3,
      successfulPosts: 1,
      failedPosts: 1,
      netResidualAfterFeed: null,
      comparisonReason: "feed_collection_incomplete",
    });
    expect(response.summary.comparableDays).toBe(0);
  });

  it("flags multi-day deltas and counter corrections instead of comparing them", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-04",
      trackingStartedAt: new Date("2026-08-01T10:00:00Z"),
      posts: [post()],
      snapshots: [
        snapshot("2026-08-01", 5),
        snapshot("2026-08-02", null, "unavailable"),
        snapshot("2026-08-03", 9),
        snapshot("2026-08-04", 8),
      ],
      followerPoints: [
        followerPoint("2026-08-02", 1),
        followerPoint("2026-08-03", 4),
        followerPoint("2026-08-04", 2),
      ],
    });

    expect(response.days.map((day) => [day.day, day.comparisonReason])).toEqual([
      ["2026-08-02", "feed_collection_incomplete"],
      ["2026-08-03", "feed_multi_day_delta"],
      ["2026-08-04", "feed_counter_correction"],
    ]);
    expect(response.days[1]).toMatchObject({ attributedFeedFollows: 4, hasMultiDayDelta: true });
    expect(response.days[2]).toMatchObject({ attributedFeedFollows: -1, hasCounterCorrection: true });
  });

  it("withholds comparisons for provisional account data", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-02",
      trackingStartedAt: new Date("2026-08-01T10:00:00Z"),
      posts: [post()],
      snapshots: [snapshot("2026-08-01", 5), snapshot("2026-08-02", 6)],
      followerPoints: [followerPoint("2026-08-02", 2, { provisional: true })],
    });

    expect(response.days[0]).toMatchObject({
      accountProvisional: true,
      netResidualAfterFeed: null,
      comparisonReason: "account_provisional",
    });
  });

  it("marks publication day missing and a next-day first reading as multi-day", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-04",
      to: "2026-08-05",
      trackingStartedAt: new Date("2026-08-01T10:00:00Z"),
      posts: [
        post({
          postedAt: new Date("2026-08-04T22:00:00Z"),
          firstSeenAt: new Date("2026-08-05T06:00:00Z"),
          baselineFollows: 0,
          baselineCapturedAt: new Date("2026-08-04T22:00:00Z"),
        }),
      ],
      snapshots: [snapshot("2026-08-05", 4)],
      followerPoints: [followerPoint("2026-08-04", 3), followerPoint("2026-08-05", 5)],
    });

    expect(response.days[0]).toMatchObject({
      day: "2026-08-04",
      collectionStatus: "missing",
      eligiblePosts: 1,
      missingPosts: 1,
      comparisonReason: "feed_collection_incomplete",
    });
    expect(response.days[1]).toMatchObject({
      day: "2026-08-05",
      collectionStatus: "complete",
      attributedFeedFollows: 4,
      hasMultiDayDelta: true,
      comparisonReason: "feed_multi_day_delta",
      posts: [{ mediaId: "post-1", delta: 4, spanDays: 2 }],
    });
  });

  it("never compares the partial Pacific day on which tracking starts", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-02",
      trackingStartedAt: new Date("2026-08-02T10:00:00Z"),
      posts: [
        post({
          firstSeenAt: new Date("2026-08-02T10:00:00Z"),
          baselineFollows: 5,
          baselineCapturedAt: new Date("2026-08-02T10:00:00Z"),
        }),
      ],
      snapshots: [snapshot("2026-08-02", 5)],
      followerPoints: [followerPoint("2026-08-02", 4)],
    });

    expect(response.days[0]).toMatchObject({
      collectionStatus: "partial",
      attributedFeedFollows: 0,
      netResidualAfterFeed: null,
      comparisonReason: "feed_tracking_partial_day",
    });
  });

  it("marks the Pacific tracking day partial even at exact Pacific midnight", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-02",
      to: "2026-08-02",
      trackingStartedAt: new Date("2026-08-02T07:00:00Z"),
      posts: [
        post({
          firstSeenAt: new Date("2026-08-02T07:05:00Z"),
          baselineFollows: 5,
          baselineCapturedAt: new Date("2026-08-02T07:05:00Z"),
        }),
      ],
      snapshots: [snapshot("2026-08-02", 5)],
      followerPoints: [followerPoint("2026-08-02", 4)],
    });

    expect(response.days[0]).toMatchObject({
      collectionStatus: "partial",
      netResidualAfterFeed: null,
      comparisonReason: "feed_tracking_partial_day",
    });
  });

  it("uses Pacific publication and first-seen days for eligibility", () => {
    const response = buildFeedFollowAttribution({
      from: "2026-08-04",
      to: "2026-08-04",
      trackingStartedAt: new Date("2026-08-01T07:00:00Z"),
      posts: [
        post({
          postedAt: new Date("2026-08-05T00:30:00Z"),
          firstSeenAt: new Date("2026-08-05T01:00:00Z"),
          baselineFollows: 0,
          baselineCapturedAt: new Date("2026-08-05T00:30:00Z"),
        }),
      ],
      snapshots: [snapshot("2026-08-04", 2)],
      followerPoints: [followerPoint("2026-08-04", 3)],
    });

    expect(response.days[0]).toMatchObject({ day: "2026-08-04", eligiblePosts: 1 });
  });
});

describe("parseFeedFollowAttributionRange", () => {
  it("defaults to the latest 30 inclusive Pacific days", () => {
    expect(parseFeedFollowAttributionRange({}, new Date("2026-08-05T00:05:00Z"))).toEqual({
      from: "2026-07-06",
      to: "2026-08-04",
    });
  });

  it("rejects invalid calendar dates and ranges longer than 90 inclusive days", () => {
    expect(() =>
      parseFeedFollowAttributionRange({ from: "2026-08-32", to: "2026-09-01" }),
    ).toThrow("invalid_date_range");
    expect(() =>
      parseFeedFollowAttributionRange({ from: "2026-01-01", to: "2026-04-01" }),
    ).toThrow("invalid_date_range");
  });
});
