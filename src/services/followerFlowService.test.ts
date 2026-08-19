import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    geoDemographicSnapshot: { findMany: vi.fn() },
    followerTotalSnapshot: { findMany: vi.fn() },
    followerChurnDaySnapshot: { findMany: vi.fn() },
  },
}));
vi.mock("../meta/profileFetcher.js", () => ({
  fetchProfileTotals: vi.fn().mockResolvedValue({ followersTotal: null }),
}));
vi.mock("./spikeService.js", () => ({ getSpikesByDay: vi.fn().mockResolvedValue(new Map()) }));

const { prisma } = await import("../lib/prisma.js");
const { getFollowerDailyAdds, getFollowerDailyAddsPointsForRange } = await import(
  "./followerFlowService.js"
);

// Default: no followers_count history. Every assertion below that predates the
// exact-total anchoring then describes the pure demographic path it was written
// for — followerAllocationCore leaves a day it cannot anchor exactly as it found
// it. Tests that DO exercise the anchoring override this per call.
beforeEach(() => {
  vi.mocked(prisma.followerTotalSnapshot.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.followerChurnDaySnapshot.findMany).mockResolvedValue([] as never);
});

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
        capturedAt: { lt: new Date("2025-08-05T07:00:00Z") },
      },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, counts: true, totalCounted: true },
    });
  });

  it("splits the known August refresh into separate Pacific days", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
      { capturedAt: new Date("2026-08-05T00:00:00Z"), counts: { US: 5_057 }, totalCounted: 5_057 },
      { capturedAt: new Date("2026-08-05T12:05:00Z"), counts: { US: 5_057 }, totalCounted: 5_057 },
      { capturedAt: new Date("2026-08-06T00:05:08Z"), counts: { US: 5_218 }, totalCounted: 5_218 },
      { capturedAt: new Date("2026-08-06T12:05:00Z"), counts: { US: 5_382 }, totalCounted: 5_382 },
    ] as never);

    const points = await getFollowerDailyAddsPointsForRange({
      from: "2026-08-05",
      to: "2026-08-06",
    });

    expect(points.map(({ day, total, reportedTotalDelta, spanDays, basis }) => ({
      day,
      total,
      reportedTotalDelta,
      spanDays,
      basis,
    }))).toEqual([
      { day: "2026-08-05", total: 161, reportedTotalDelta: 161, spanDays: 1, basis: "diff" },
      { day: "2026-08-06", total: 164, reportedTotalDelta: 164, spanDays: 1, basis: "diff" },
    ]);
  });

  it("keeps a truly stale Pacific day combined with the next refresh", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
      { capturedAt: new Date("2026-07-21T00:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-21T12:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-22T00:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-22T12:00:00Z"), counts: { US: 168 }, totalCounted: 168 },
    ] as never);

    const points = await getFollowerDailyAddsPointsForRange({
      from: "2026-07-21",
      to: "2026-07-22",
    });

    expect(points.map(({ day, total, spanDays, basis }) => ({ day, total, spanDays, basis }))).toEqual([
      { day: "2026-07-21", total: null, spanDays: null, basis: "stale" },
      { day: "2026-07-22", total: 68, spanDays: 2, basis: "multi_day_span" },
    ]);
  });

  it("reports the active analytics timezone", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([]);
    await expect(getFollowerDailyAdds()).resolves.toMatchObject({
      analyticsTimeZone: "America/Los_Angeles",
    });
  });

  it("splits a stale-day catch-up bar once followers_count anchors it", async () => {
    // The same July 21-22 data as the stale-day case above, but now with the
    // true follower total captured on both days. The combined +68 bar becomes
    // two real days summing to the growth that actually happened (+240), which
    // is the whole point of the exact-total anchoring.
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
      { capturedAt: new Date("2026-07-20T12:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-21T12:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-22T12:00:00Z"), counts: { US: 168 }, totalCounted: 168 },
    ] as never);
    vi.mocked(prisma.followerTotalSnapshot.findMany).mockResolvedValueOnce([
      { capturedAt: new Date("2026-07-20T12:00:00Z"), followersTotal: 5000 },
      { capturedAt: new Date("2026-07-21T12:00:00Z"), followersTotal: 5140 },
      { capturedAt: new Date("2026-07-22T12:00:00Z"), followersTotal: 5240 },
    ] as never);

    const points = await getFollowerDailyAddsPointsForRange({
      from: "2026-07-21",
      to: "2026-07-22",
    });

    expect(
      points.map(({ day, total, spanDays, basis, estimated, exactTotal }) => ({
        day,
        total,
        spanDays,
        basis,
        estimated,
        exactTotal,
      })),
    ).toEqual([
      { day: "2026-07-21", total: 140, spanDays: 1, basis: "diff", estimated: true, exactTotal: 140 },
      { day: "2026-07-22", total: 100, spanDays: 1, basis: "diff", estimated: true, exactTotal: 100 },
    ]);
    expect(points.every((point) => point.byCountry?.US === point.total)).toBe(true);
  });

  it("attaches Meta's churn ledger only to the days it answered", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([
      { capturedAt: new Date("2026-07-20T12:00:00Z"), counts: { US: 100 }, totalCounted: 100 },
      { capturedAt: new Date("2026-07-21T12:00:00Z"), counts: { US: 140 }, totalCounted: 140 },
      { capturedAt: new Date("2026-07-22T12:00:00Z"), counts: { US: 168 }, totalCounted: 168 },
    ] as never);
    vi.mocked(prisma.followerChurnDaySnapshot.findMany).mockResolvedValueOnce([
      { day: new Date("2026-07-21T00:00:00Z"), follows: 190, unfollows: 50 },
    ] as never);

    const points = await getFollowerDailyAddsPointsForRange({
      from: "2026-07-21",
      to: "2026-07-22",
    });

    expect(points.map(({ day, follows, unfollows }) => ({ day, follows, unfollows }))).toEqual([
      { day: "2026-07-21", follows: 190, unfollows: 50 },
      // Meta gave no figure for the 22nd: null, never 0 — "nobody unfollowed"
      // and "we do not know" must not render the same way.
      { day: "2026-07-22", follows: null, unfollows: null },
    ]);
  });

  it("reads followers_count over the same window as the demographic anchors", async () => {
    vi.mocked(prisma.geoDemographicSnapshot.findMany).mockResolvedValueOnce([]);
    await getFollowerDailyAddsPointsForRange({ from: "2026-07-21", to: "2026-07-22" });
    expect(prisma.followerTotalSnapshot.findMany).toHaveBeenCalledWith({
      where: { capturedAt: { lt: new Date("2026-07-25T07:00:00Z") } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, followersTotal: true },
    });
  });
});
