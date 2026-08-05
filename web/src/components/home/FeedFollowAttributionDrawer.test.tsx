import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  FeedFollowAttributionDay,
  FeedFollowAttributionResponse,
} from "@/lib/types";
import { FeedFollowAttributionDrawer } from "./FeedFollowAttributionDrawer";

function attributionDay(
  overrides: Partial<FeedFollowAttributionDay> = {},
): FeedFollowAttributionDay {
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

function response(day: FeedFollowAttributionDay): FeedFollowAttributionResponse {
  return {
    range: { from: day.day, to: day.day },
    tracking: {
      startedAt: "2026-08-01T18:00:00.000Z",
      lastAttemptAt: "2026-08-04T00:00:00.000Z",
      lastCompletedAt: "2026-08-04T00:01:00.000Z",
      lastStatus: "ok",
      eligibleCount: 3,
      writtenCount: 3,
      unavailableCount: 0,
      failedCount: 0,
      lastError: null,
      trackedPosts: 3,
      latestSnapshotDay: "2026-08-04",
    },
    days: [day],
    summary: {
      comparableDays: day.netResidualAfterFeed === null ? 0 : 1,
      attributedFeedFollows: day.attributedFeedFollows ?? 0,
      accountNetAdds: day.accountNetAdds ?? 0,
      netResidualAfterFeed: day.netResidualAfterFeed ?? 0,
    },
    caveats: [
      "Feed-attributed follows are gross follows credited by Meta to regular feed posts.",
      "Account daily adds are net follows minus unfollows.",
    ],
  };
}

function renderDrawer(
  props: Partial<React.ComponentProps<typeof FeedFollowAttributionDrawer>> = {},
): string {
  return renderToStaticMarkup(
    <FeedFollowAttributionDrawer
      day="2026-08-03"
      data={undefined}
      isLoading={false}
      isError={false}
      onRetry={() => undefined}
      onClose={() => undefined}
      {...props}
    />,
  );
}

describe("FeedFollowAttributionDrawer", () => {
  it("leaves the chart interactive so another day can replace the selection", () => {
    const html = renderDrawer({ data: response(attributionDay()) });
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain("fixed inset-0 z-40 bg-black/60");
  });

  it("keeps the selected date visible while loading", () => {
    const html = renderDrawer({ isLoading: true });
    expect(html).toContain("August 3, 2026");
    expect(html).toContain("Loading feed attribution");
  });

  it("keeps the selected date and offers retry after a request error", () => {
    const html = renderDrawer({ isError: true });
    expect(html).toContain("August 3, 2026");
    expect(html).toContain("Could not load feed attribution");
    expect(html).toContain(">Retry<");
  });

  it("does not describe dates before tracking as zero", () => {
    const beforeTracking = attributionDay({
      collectionStatus: "not_started",
      eligiblePosts: 0,
      successfulPosts: 0,
      attributedFeedFollows: null,
      posts: [],
      accountNetAdds: 8,
      netResidualAfterFeed: null,
      comparisonReason: "feed_not_started",
    });
    const html = renderDrawer({ data: response(beforeTracking) });
    expect(html).toContain("Before tracking");
    expect(html).toContain("historical feed-post follows were not fabricated");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Meta attributed no feed-post follows");
  });

  it("gives a definitive empty message only for a complete zero day", () => {
    const zero = attributionDay({
      attributedFeedFollows: 0,
      posts: [],
      netResidualAfterFeed: 12,
    });
    const html = renderDrawer({ data: response(zero) });
    expect(html).toContain("Meta attributed no feed-post follows on this day");
    expect(html).toContain("Complete");
  });

  it("shows collection uncertainty instead of treating partial evidence as complete", () => {
    const partial = attributionDay({
      collectionStatus: "partial",
      eligiblePosts: 5,
      successfulPosts: 2,
      unavailablePosts: 1,
      failedPosts: 1,
      missingPosts: 1,
      attributedFeedFollows: 4,
      netResidualAfterFeed: null,
      comparisonReason: "feed_collection_incomplete",
    });
    const html = renderDrawer({ data: response(partial) });
    expect(html).toContain("Partial collection");
    expect(html).toContain("1 unavailable, 1 failed, and 1 missing");
    expect(html).toContain("readings are incomplete");
  });

  it("shows the contributing post and frames the remainder as directional", () => {
    const withPost = attributionDay({
      posts: [
        {
          mediaId: "ig-123",
          mediaType: "CAROUSEL_ALBUM",
          caption: "The five-minute pantry reset",
          permalink: "https://www.instagram.com/p/example/",
          thumbnailUrl: "https://cdn.example.com/post.jpg",
          postedAt: "2026-07-31T19:00:00.000Z",
          follows: 12,
          delta: 7,
          spanDays: 1,
        },
      ],
    });
    const html = renderDrawer({ data: response(withPost) });
    expect(html).toContain("The five-minute pantry reset");
    expect(html).toContain("Carousel");
    expect(html).toContain("+7");
    expect(html).toContain("12 lifetime");
    expect(html).toContain('href="https://www.instagram.com/p/example/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Directional remainder");
    expect(html).toContain("directional diagnostic");
    expect(html).toContain("Reels and Stories are not included");
    expect(html).not.toMatch(/reel.+caused|caused.+reel/i);
  });
});
