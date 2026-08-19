import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    followerChurnDaySnapshot: { findMany: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("../meta/followsFetcher.js", () => ({ fetchFollowerChurn: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { prisma } = await import("../lib/prisma.js");
const { fetchFollowerChurn } = await import("../meta/followsFetcher.js");
const { collectFollowerChurn, daysToFetch } = await import("./followerChurnWorker.js");

const known = (entries: Array<[string, string]>) => new Map(entries);

describe("daysToFetch", () => {
  it("always re-requests the trailing settling window, stored or not", () => {
    const all = known(
      Array.from({ length: 90 }, (_, i) => {
        const day = new Date(Date.parse("2026-08-19T00:00:00Z") - i * 86400000)
          .toISOString()
          .slice(0, 10);
        return [day, "ok"] as [string, string];
      }),
    );
    // Everything is stored, so only Meta's ~48h settling window comes back.
    expect(daysToFetch("2026-08-19", all)).toEqual([
      "2026-08-19",
      "2026-08-18",
      "2026-08-17",
    ]);
  });

  it("fills gaps behind the settling window, newest first", () => {
    const stored = known([
      ["2026-08-16", "ok"],
      ["2026-08-14", "ok"],
    ]);
    const targets = daysToFetch("2026-08-19", stored, 6);
    expect(targets).toEqual([
      "2026-08-19",
      "2026-08-18",
      "2026-08-17",
      "2026-08-15",
      "2026-08-13",
      "2026-08-12",
    ]);
    expect(targets).not.toContain("2026-08-16");
  });

  it("never re-requests a settled unavailable day", () => {
    // Meta has answered "no data" for that day and will not change its mind;
    // retrying it every tick would spend the whole budget on dead days.
    const stored = known([["2026-08-10", "unavailable"]]);
    expect(daysToFetch("2026-08-19", stored, 20)).not.toContain("2026-08-10");
  });

  it("does re-request an unavailable day inside the settling window", () => {
    const stored = known([["2026-08-18", "unavailable"]]);
    expect(daysToFetch("2026-08-19", stored, 3)).toContain("2026-08-18");
  });

  it("caps the burst so a cold start cannot flood the Graph API", () => {
    expect(daysToFetch("2026-08-19", known([]), 20)).toHaveLength(20);
    expect(daysToFetch("2026-08-19", known([]), 20)[0]).toBe("2026-08-19");
  });

  it("stops at the lookback horizon", () => {
    const targets = daysToFetch("2026-08-19", known([]), 200);
    expect(targets).toHaveLength(90);
    expect(targets[89]).toBe("2026-05-22");
  });
});

describe("collectFollowerChurn", () => {
  it("stores both sides of a day Meta answered", async () => {
    vi.mocked(prisma.followerChurnDaySnapshot.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(fetchFollowerChurn).mockResolvedValue({ follows: 210, unfollows: 34 });

    const result = await collectFollowerChurn({
      now: new Date("2026-08-19T18:00:00Z"),
      limit: 3,
      gapMs: 0,
    });

    expect(result.ok).toBe(3);
    expect(vi.mocked(prisma.followerChurnDaySnapshot.upsert).mock.calls[0]![0]).toMatchObject({
      update: { follows: 210, unfollows: 34, status: "ok" },
    });
  });

  it("records a day Meta declines so the backfill stops asking", async () => {
    vi.mocked(prisma.followerChurnDaySnapshot.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(fetchFollowerChurn).mockResolvedValue(null);
    vi.mocked(prisma.followerChurnDaySnapshot.upsert).mockClear();

    const result = await collectFollowerChurn({
      now: new Date("2026-08-19T18:00:00Z"),
      limit: 3,
      gapMs: 0,
    });

    expect(result.ok).toBe(0);
    expect(result.unavailable).toBe(3);
    expect(vi.mocked(prisma.followerChurnDaySnapshot.upsert).mock.calls[0]![0]).toMatchObject({
      update: { follows: null, unfollows: null, status: "unavailable" },
    });
  });

  it("keeps a stored figure when a re-request transiently fails", async () => {
    // Otherwise a rate-limited tick erases churn the chart had been showing.
    vi.mocked(prisma.followerChurnDaySnapshot.findMany).mockResolvedValueOnce([
      { day: new Date("2026-08-19T00:00:00Z"), status: "ok" },
      { day: new Date("2026-08-18T00:00:00Z"), status: "ok" },
      { day: new Date("2026-08-17T00:00:00Z"), status: "ok" },
    ] as never);
    vi.mocked(fetchFollowerChurn).mockResolvedValue(null);
    vi.mocked(prisma.followerChurnDaySnapshot.upsert).mockClear();

    const result = await collectFollowerChurn({
      now: new Date("2026-08-19T18:00:00Z"),
      limit: 3,
      gapMs: 0,
    });

    expect(result.kept).toBe(3);
    expect(result.unavailable).toBe(0);
    expect(prisma.followerChurnDaySnapshot.upsert).not.toHaveBeenCalled();
  });
});
