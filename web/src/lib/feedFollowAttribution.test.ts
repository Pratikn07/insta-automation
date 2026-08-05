import { describe, expect, it } from "vitest";
import type { FeedFollowAttributionDay, FeedFollowComparisonReason } from "./types";
import {
  feedCollectionCopy,
  feedComparisonExplanation,
  feedMediaLabel,
} from "./feedFollowAttribution";

function day(overrides: Partial<FeedFollowAttributionDay> = {}): FeedFollowAttributionDay {
  return {
    day: "2026-08-03",
    collectionStatus: "complete",
    eligiblePosts: 3,
    successfulPosts: 3,
    unavailablePosts: 0,
    failedPosts: 0,
    missingPosts: 0,
    attributedFeedFollows: 7,
    posts: [],
    hasCounterCorrection: false,
    hasMultiDayDelta: false,
    accountNetAdds: 12,
    accountBasis: "diff",
    accountProvisional: false,
    netResidualAfterFeed: 5,
    comparisonReason: null,
    ...overrides,
  };
}

describe("feedMediaLabel", () => {
  it.each([
    ["CAROUSEL_ALBUM", "Carousel"],
    ["IMAGE", "Image post"],
    ["VIDEO", "Feed video"],
    [null, "Feed post"],
    ["UNKNOWN", "Feed post"],
  ])("labels Meta media type %s as %s", (mediaType, label) => {
    expect(feedMediaLabel(mediaType)).toBe(label);
  });
});

describe("feedComparisonExplanation", () => {
  it.each<[FeedFollowComparisonReason, string]>([
    ["feed_not_started", "Tracking had not started"],
    ["feed_tracking_partial_day", "started partway"],
    ["feed_collection_incomplete", "readings are incomplete"],
    ["feed_multi_day_delta", "multiple days"],
    ["feed_counter_correction", "corrected"],
    ["account_missing", "Account net follower change is unavailable"],
    ["account_provisional", "still settling"],
    ["account_not_one_day", "one-day comparison"],
  ])("explains %s without claiming Reel attribution", (reason, expectedText) => {
    const explanation = feedComparisonExplanation(reason);
    expect(explanation).toContain(expectedText);
    expect(explanation).not.toMatch(/reel.+caused|caused.+reel/i);
  });

  it("returns no explanation when the comparison is valid", () => {
    expect(feedComparisonExplanation(null)).toBeNull();
  });
});

describe("feedCollectionCopy", () => {
  it("marks a fully captured day complete", () => {
    expect(feedCollectionCopy(day())).toEqual({
      label: "Complete",
      detail: "Meta returned follow counts for all 3 eligible feed posts.",
      tone: "good",
    });
  });

  it("lists each source of uncertainty on a partial day", () => {
    expect(
      feedCollectionCopy(
        day({
          collectionStatus: "partial",
          eligiblePosts: 5,
          successfulPosts: 2,
          unavailablePosts: 1,
          failedPosts: 1,
          missingPosts: 1,
          attributedFeedFollows: 4,
          comparisonReason: "feed_collection_incomplete",
        }),
      ),
    ).toEqual({
      label: "Partial collection",
      detail: "2 of 5 posts captured; 1 unavailable, 1 failed, and 1 missing.",
      tone: "caution",
    });
  });

  it("explains a deployment day where every post reading succeeded", () => {
    expect(
      feedCollectionCopy(
        day({
          collectionStatus: "partial",
          eligiblePosts: 37,
          successfulPosts: 37,
          attributedFeedFollows: 0,
          netResidualAfterFeed: null,
          comparisonReason: "feed_tracking_partial_day",
        }),
      ),
    ).toEqual({
      label: "Partial collection",
      detail: "All 37 post readings succeeded, but tracking began partway through this UTC day.",
      tone: "caution",
    });
  });

  it("does not turn a day before tracking into a zero", () => {
    expect(
      feedCollectionCopy(
        day({
          collectionStatus: "not_started",
          eligiblePosts: 0,
          successfulPosts: 0,
          attributedFeedFollows: null,
          accountNetAdds: 8,
          netResidualAfterFeed: null,
          comparisonReason: "feed_not_started",
        }),
      ),
    ).toEqual({
      label: "Before tracking",
      detail: "Tracking had not started, so historical feed-post follows were not fabricated.",
      tone: "muted",
    });
  });

  it("treats a day with no usable readings as missing rather than zero", () => {
    expect(
      feedCollectionCopy(
        day({
          collectionStatus: "missing",
          eligiblePosts: 3,
          successfulPosts: 0,
          unavailablePosts: 0,
          failedPosts: 0,
          missingPosts: 3,
          attributedFeedFollows: null,
          netResidualAfterFeed: null,
          comparisonReason: "feed_collection_incomplete",
        }),
      ),
    ).toEqual({
      label: "Collection unavailable",
      detail: "No usable readings for 3 eligible feed posts; 3 missing.",
      tone: "caution",
    });
  });
});
