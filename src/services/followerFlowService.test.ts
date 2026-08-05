import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({
  prisma: { geoDemographicSnapshot: { findMany: vi.fn() } },
}));
vi.mock("../meta/profileFetcher.js", () => ({
  fetchProfileTotals: vi.fn().mockResolvedValue({ followersTotal: null }),
}));
vi.mock("./spikeService.js", () => ({ getSpikesByDay: vi.fn().mockResolvedValue(new Map()) }));

const { prisma } = await import("../lib/prisma.js");
const { getFollowerDailyAddsPointsForRange } = await import("./followerFlowService.js");

describe("getFollowerDailyAddsPointsForRange", () => {
  it("uses the stored predecessor anchor for an explicit historical range", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
      {
        capturedAt: new Date("2025-07-31T20:00:00Z"),
        counts: { US: 10 },
        totalCounted: 10,
      },
      {
        capturedAt: new Date("2025-08-01T20:00:00Z"),
        counts: { US: 12 },
        totalCounted: 12,
      },
      {
        capturedAt: new Date("2025-08-02T20:00:00Z"),
        counts: { US: 15 },
        totalCounted: 15,
      },
      {
        capturedAt: new Date("2025-08-03T20:00:00Z"),
        counts: { US: 16 },
        totalCounted: 16,
      },
      {
        capturedAt: new Date("2025-08-04T20:00:00Z"),
        counts: { US: 17 },
        totalCounted: 17,
      },
    ] as never);

    const points = await getFollowerDailyAddsPointsForRange({
      from: "2025-08-01",
      to: "2025-08-02",
    });

    expect(points.map((point) => [point.day, point.total, point.provisional])).toEqual([
      ["2025-08-01", 2, false],
      ["2025-08-02", 3, false],
    ]);
    expect(prisma.geoDemographicSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        stage: "follower",
        capturedAt: { lt: new Date("2025-08-05T00:00:00Z") },
      },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, counts: true, totalCounted: true },
    });
  });
});
