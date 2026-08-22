import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    reelPerformanceSnapshot: { findMany: vi.fn() },
    reelMeta: { findMany: vi.fn() },
  },
}));

const { prisma } = await import("../lib/prisma.js");
const { getSpikesByDay, spikeAttributionWindow } = await import("./spikeService.js");

function point(day: string, total: number): FollowerDailyAddsPoint {
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
  };
}

beforeEach(() => {
  vi.mocked(prisma.reelPerformanceSnapshot.findMany).mockReset();
  vi.mocked(prisma.reelMeta.findMany).mockReset();
});

describe("spikeAttributionWindow", () => {
  it("builds the summer query around Pacific calendar days", () => {
    expect(spikeAttributionWindow("2026-08-05")).toEqual({
      queryStart: new Date("2026-08-02T07:00:00.000Z"),
      windowStartMs: Date.parse("2026-08-04T07:00:00.000Z"),
      windowEndMs: Date.parse("2026-08-07T06:59:59.999Z"),
    });
  });

  it("does not assume 24-hour days across fall-back", () => {
    expect(spikeAttributionWindow("2026-11-01")).toEqual({
      queryStart: new Date("2026-10-29T07:00:00.000Z"),
      windowStartMs: Date.parse("2026-10-31T07:00:00.000Z"),
      windowEndMs: Date.parse("2026-11-03T07:59:59.999Z"),
    });
  });
});

describe("getSpikesByDay", () => {
  it("queries and returns August spikes by Pacific analytics day", async () => {
    prisma.reelPerformanceSnapshot.findMany.mockResolvedValueOnce([
      {
        mediaId: "reel-1",
        capturedAt: new Date("2026-08-03T20:00:00.000Z"),
        reach: 100,
      },
      {
        mediaId: "reel-1",
        capturedAt: new Date("2026-08-06T20:00:00.000Z"),
        reach: 500,
      },
    ] as never);
    prisma.reelMeta.findMany.mockResolvedValueOnce([
      {
        mediaId: "reel-1",
        caption: "Candidate reel",
        thumbnailUrl: null,
        permalink: "https://instagram.com/reel/reel-1",
        postedAt: new Date("2026-08-01T20:00:00.000Z"),
      },
    ] as never);

    const spikes = await getSpikesByDay([
      point("2026-07-29", 40),
      point("2026-07-30", 40),
      point("2026-07-31", 40),
      point("2026-08-01", 40),
      point("2026-08-02", 40),
      point("2026-08-03", 40),
      point("2026-08-04", 40),
      point("2026-08-05", 200),
    ]);

    expect(prisma.reelPerformanceSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        capturedAt: {
          gte: new Date("2026-08-02T07:00:00.000Z"),
          lte: new Date("2026-08-07T06:59:59.999Z"),
        },
      },
      orderBy: { capturedAt: "asc" },
      select: { mediaId: true, capturedAt: true, reach: true },
    });
    expect([...spikes.keys()]).toEqual(["2026-08-05"]);
  });

  /**
   * The regression that made /api/insights/follower-daily-adds a ten-second
   * request: this loaded snapshots and metadata once PER spike day, on the
   * assumption that spikes stay rare. A 90-day lookback detects 13 of them, so
   * the loop became 26 sequential round trips.
   */
  it("stays at two queries when several days spike", async () => {
    const days: FollowerDailyAddsPoint[] = [];
    for (let d = 1; d <= 10; d++) days.push(point(`2026-07-${String(d).padStart(2, "0")}`, 40));
    days.push(point("2026-07-11", 200)); // spike 1
    for (let d = 12; d <= 21; d++) days.push(point(`2026-07-${d}`, 40));
    days.push(point("2026-07-22", 200)); // spike 2

    prisma.reelPerformanceSnapshot.findMany.mockResolvedValueOnce([
      // reel-A grows inside spike 1's window only.
      { mediaId: "reel-a", capturedAt: new Date("2026-07-09T20:00:00.000Z"), reach: 100 },
      { mediaId: "reel-a", capturedAt: new Date("2026-07-12T20:00:00.000Z"), reach: 500 },
      // reel-B grows inside spike 2's window only.
      { mediaId: "reel-b", capturedAt: new Date("2026-07-20T20:00:00.000Z"), reach: 100 },
      { mediaId: "reel-b", capturedAt: new Date("2026-07-23T20:00:00.000Z"), reach: 600 },
    ] as never);
    prisma.reelMeta.findMany.mockResolvedValueOnce([
      { mediaId: "reel-a", caption: "A", thumbnailUrl: null, permalink: null, postedAt: null },
      { mediaId: "reel-b", caption: "B", thumbnailUrl: null, permalink: null, postedAt: null },
    ] as never);

    const spikes = await getSpikesByDay(days);

    expect([...spikes.keys()]).toEqual(["2026-07-11", "2026-07-22"]);
    expect(prisma.reelPerformanceSnapshot.findMany).toHaveBeenCalledOnce();
    expect(prisma.reelMeta.findMany).toHaveBeenCalledOnce();

    // One query spanning both windows, reaching back for spike 1's baseline.
    expect(prisma.reelPerformanceSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          capturedAt: {
            gte: new Date("2026-07-08T07:00:00.000Z"),
            lte: new Date("2026-07-24T06:59:59.999Z"),
          },
        },
      }),
    );
  });

  /**
   * The single query is wider than any one spike's window, so each spike must be
   * narrowed back to its own bounds before ranking. Without that, one day's reel
   * would be credited for another day's followers.
   */
  it("keeps each spike's attribution inside its own window", async () => {
    const days: FollowerDailyAddsPoint[] = [];
    for (let d = 1; d <= 10; d++) days.push(point(`2026-07-${String(d).padStart(2, "0")}`, 40));
    days.push(point("2026-07-11", 200));
    for (let d = 12; d <= 21; d++) days.push(point(`2026-07-${d}`, 40));
    days.push(point("2026-07-22", 200));

    prisma.reelPerformanceSnapshot.findMany.mockResolvedValueOnce([
      { mediaId: "reel-a", capturedAt: new Date("2026-07-09T20:00:00.000Z"), reach: 100 },
      { mediaId: "reel-a", capturedAt: new Date("2026-07-12T20:00:00.000Z"), reach: 500 },
      { mediaId: "reel-b", capturedAt: new Date("2026-07-20T20:00:00.000Z"), reach: 100 },
      { mediaId: "reel-b", capturedAt: new Date("2026-07-23T20:00:00.000Z"), reach: 600 },
    ] as never);
    prisma.reelMeta.findMany.mockResolvedValueOnce([
      { mediaId: "reel-a", caption: "A", thumbnailUrl: null, permalink: null, postedAt: null },
      { mediaId: "reel-b", caption: "B", thumbnailUrl: null, permalink: null, postedAt: null },
    ] as never);

    const spikes = await getSpikesByDay(days);

    expect(spikes.get("2026-07-11")!.candidates.map((c) => c.mediaId)).toEqual(["reel-a"]);
    expect(spikes.get("2026-07-22")!.candidates.map((c) => c.mediaId)).toEqual(["reel-b"]);
  });
});
