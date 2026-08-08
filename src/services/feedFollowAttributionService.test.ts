import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    feedFollowCollectorState: { findUnique: vi.fn() },
    feedPostMeta: { findMany: vi.fn() },
    feedFollowDailySnapshot: { findMany: vi.fn() },
  },
}));
vi.mock("./followerFlowService.js", () => ({ getFollowerDailyAddsPointsForRange: vi.fn() }));

const { prisma } = await import("../lib/prisma.js");
const { getFollowerDailyAddsPointsForRange } = await import("./followerFlowService.js");
const { getFeedFollowAttribution } = await import("./feedFollowAttributionService.js");

describe("getFeedFollowAttribution", () => {
  it("returns tracking health and derives the requested day from cumulative snapshots", async () => {
    vi.mocked(prisma.feedFollowCollectorState.findUnique).mockResolvedValueOnce({
      scope: "feed",
      startedAt: new Date("2026-08-01T10:00:00Z"),
      lastAttemptAt: new Date("2026-08-03T18:00:00Z"),
      lastCompletedAt: new Date("2026-08-03T18:01:00Z"),
      lastStatus: "success",
      eligibleCount: 1,
      writtenCount: 1,
      unavailableCount: 0,
      failedCount: 0,
      lastError: null,
      updatedAt: new Date("2026-08-03T18:01:00Z"),
    });
    vi.mocked(prisma.feedPostMeta.findMany).mockResolvedValueOnce([
      {
        mediaId: "post-1",
        mediaType: "CAROUSEL_ALBUM",
        caption: "Carousel",
        permalink: "https://instagram.com/p/post-1",
        thumbnailUrl: null,
        postedAt: new Date("2026-07-01T12:00:00Z"),
        firstSeenAt: new Date("2026-08-01T10:00:00Z"),
        baselineFollows: 2,
        baselineCapturedAt: new Date("2026-08-01T10:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.feedFollowDailySnapshot.findMany).mockResolvedValueOnce([
      {
        mediaId: "post-1",
        day: new Date("2026-08-01T00:00:00Z"),
        capturedAt: new Date("2026-08-01T18:00:00Z"),
        follows: 2,
        status: "ok",
      },
      {
        mediaId: "post-1",
        day: new Date("2026-08-02T00:00:00Z"),
        capturedAt: new Date("2026-08-02T18:00:00Z"),
        follows: 5,
        status: "ok",
      },
    ] as never);
    vi.mocked(getFollowerDailyAddsPointsForRange).mockResolvedValueOnce([
        {
          day: "2026-08-02",
          capturedAt: "2026-08-02T12:00:00Z",
          us: 4,
          southAsian: 0,
          anglosphere: 0,
          other: 0,
          total: 4,
          unattributed: 0,
          reportedTotalDelta: 4,
          spanDays: 1,
          stale: false,
          provisional: false,
          basis: "diff",
        },
    ]);

    const response = await getFeedFollowAttribution({ from: "2026-08-02", to: "2026-08-02" });

    expect(prisma.feedPostMeta.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { firstSeenAt: { lt: new Date("2026-08-03T07:00:00Z") } },
            { postedAt: { lt: new Date("2026-08-03T07:00:00Z") } },
          ],
        },
      }),
    );
    expect(prisma.feedFollowDailySnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { day: { lte: new Date("2026-08-02T00:00:00Z") } } }),
    );
    expect(response.range).toEqual({ from: "2026-08-02", to: "2026-08-02" });
    expect(response.tracking).toEqual({
      startedAt: "2026-08-01T10:00:00.000Z",
      lastAttemptAt: "2026-08-03T18:00:00.000Z",
      lastCompletedAt: "2026-08-03T18:01:00.000Z",
      lastStatus: "success",
      eligibleCount: 1,
      writtenCount: 1,
      unavailableCount: 0,
      failedCount: 0,
      lastError: null,
      trackedPosts: 1,
      latestSnapshotDay: "2026-08-02",
    });
    expect(response.days[0]).toMatchObject({
      attributedFeedFollows: 3,
      accountNetAdds: 4,
      netResidualAfterFeed: 1,
    });
    expect(response.caveats.join(" ")).toContain("gross");
  });
});
