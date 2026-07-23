import { describe, expect, it } from "vitest";
import type { FollowConversion, GeoWindowPoint, LeaderboardRow } from "./types";
import {
  formatAudienceDelta,
  rankRepeatCandidates,
  summarizeAudienceGrowth,
  summarizeFollowerYield,
} from "./homeDashboard";

function geoPoint(overrides: Partial<GeoWindowPoint> = {}): GeoWindowPoint {
  return {
    capturedAt: "2026-07-17T12:00:00.000Z",
    reachedUs90: 38,
    reachedUs14: 38,
    engagedUs90: 36,
    engagedUs14: 36,
    reachedIn14: 22,
    engagedIn14: 24,
    ...overrides,
  };
}

function reel(overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, "mediaId">): LeaderboardRow {
  const { mediaId, ...rest } = overrides;
  return {
    mediaId,
    caption: "A useful parenting reel",
    thumbnailUrl: null,
    permalink: null,
    postedAt: "2026-07-01T12:00:00.000Z",
    usFitScore: 50,
    confidence: "medium",
    mediaAudioType: null,
    videoUnavailable: false,
    analyzed: true,
    views: null,
    reach: null,
    skipRate: null,
    conversion: { keywordComments: 0, gateDelivered: 0, completed: 0 },
    captureRatePct: null,
    ...rest,
  };
}

describe("summarizeAudienceGrowth", () => {
  it("describes a two-point-or-greater reached-audience lift as growing", () => {
    expect(
      summarizeAudienceGrowth([geoPoint({ reachedUs14: 42, reachedUs90: 37 })]),
    ).toMatchObject({
      status: "growing",
      currentPct: 42,
      baselinePct: 37,
      deltaPoints: 5,
      source: "reached",
    });
  });

  it("falls back to engaged audience when reached percentages are missing", () => {
    expect(
      summarizeAudienceGrowth([
        geoPoint({ reachedUs14: null, reachedUs90: null, engagedUs14: 31, engagedUs90: 34 }),
      ]),
    ).toMatchObject({
      status: "cooling",
      currentPct: 31,
      baselinePct: 34,
      deltaPoints: -3,
      source: "engaged",
    });
  });

  it("uses the newest usable snapshot and treats small moves as steady", () => {
    const summary = summarizeAudienceGrowth([
      geoPoint({ capturedAt: "2026-07-15T12:00:00.000Z", reachedUs14: 44, reachedUs90: 38 }),
      geoPoint({ capturedAt: "2026-07-17T12:00:00.000Z", reachedUs14: 39.2, reachedUs90: 38 }),
    ]);

    expect(summary).toMatchObject({ status: "steady", deltaPoints: 1.2 });
  });

  it("returns no summary when neither reached nor engaged comparison is available", () => {
    expect(
      summarizeAudienceGrowth([
        geoPoint({
          reachedUs14: null,
          reachedUs90: null,
          engagedUs14: null,
          engagedUs90: null,
        }),
      ]),
    ).toBeNull();
  });
});

describe("formatAudienceDelta", () => {
  it("uses percentage-point language and preserves the sign", () => {
    expect(formatAudienceDelta(5)).toBe("+5.0 percentage points");
    expect(formatAudienceDelta(-2.25)).toBe("−2.3 percentage points");
  });
});

describe("rankRepeatCandidates", () => {
  it("excludes reels that only have a US-fit score and no measured performance", () => {
    const candidates = rankRepeatCandidates([
      reel({ mediaId: "measured", reach: 900, views: 1200, usFitScore: 45 }),
      reel({ mediaId: "fit-only", usFitScore: 99 }),
    ]);

    expect(candidates.map((candidate) => candidate.mediaId)).toEqual(["measured"]);
  });

  it("does not use US-fit to rank otherwise identical reels", () => {
    const candidates = rankRepeatCandidates([
      reel({ mediaId: "older-low-fit", reach: 1000, skipRate: 0.3, usFitScore: 20, postedAt: "2026-07-01T00:00:00.000Z" }),
      reel({ mediaId: "newer-high-fit", reach: 1000, skipRate: 0.3, usFitScore: 95, postedAt: "2026-07-02T00:00:00.000Z" }),
    ]);

    expect(candidates[0]?.mediaId).toBe("newer-high-fit");
    expect(candidates[0]?.score).toBe(candidates[1]?.score);
  });

  it("ranks a strong all-round performer above a one-signal reel", () => {
    const candidates = rankRepeatCandidates([
      reel({
        mediaId: "balanced",
        reach: 8000,
        skipRate: 0.2,
        conversion: { keywordComments: 120, gateDelivered: 80, completed: 45 },
      }),
      reel({ mediaId: "reach-only", reach: 10000 }),
      reel({ mediaId: "baseline", reach: 1000, skipRate: 0.8 }),
    ]);

    expect(candidates[0]?.mediaId).toBe("balanced");
  });

  it("selects a plain-language reason from the strongest normalized signal", () => {
    const candidates = rankRepeatCandidates([
      reel({ mediaId: "reach", reach: 10000, skipRate: 0.9 }),
      reel({ mediaId: "retention", reach: 1000, skipRate: 0.05 }),
      reel({
        mediaId: "guides",
        reach: 900,
        skipRate: 0.8,
        conversion: { keywordComments: 100, gateDelivered: 80, completed: 60 },
      }),
      reel({ mediaId: "floor", reach: 100, skipRate: 0.95 }),
    ]);

    expect(candidates.find((candidate) => candidate.mediaId === "reach")?.reasonKey).toBe("reach");
    expect(candidates.find((candidate) => candidate.mediaId === "retention")?.reasonKey).toBe("retention");
    expect(candidates.find((candidate) => candidate.mediaId === "guides")?.reasonKey).toBe("guides");
  });

  it("returns only the top three measured candidates", () => {
    const candidates = rankRepeatCandidates([
      reel({ mediaId: "one", reach: 4000 }),
      reel({ mediaId: "two", reach: 3000 }),
      reel({ mediaId: "three", reach: 2000 }),
      reel({ mediaId: "four", reach: 1000 }),
    ]);

    expect(candidates).toHaveLength(3);
  });
});

describe("summarizeFollowerYield", () => {
  function conv(overrides: Partial<FollowConversion> = {}): FollowConversion {
    return {
      windowDays: 30,
      deliveredToNonFollowers: 0,
      rechecked: 0,
      converted: 0,
      pending: 0,
      yieldPct: null,
      ...overrides,
    };
  }

  it("returns null when data is missing", () => {
    expect(summarizeFollowerYield(undefined)).toBeNull();
    expect(summarizeFollowerYield(null)).toBeNull();
  });

  it("is empty with no rechecks and mentions pending measurement", () => {
    const summary = summarizeFollowerYield(conv({ deliveredToNonFollowers: 4, pending: 4 }));
    expect(summary?.state).toBe("empty");
    expect(summary?.yieldPct).toBeNull();
    expect(summary?.headline).toContain("4");
  });

  it("reports a measured yield", () => {
    const summary = summarizeFollowerYield(
      conv({ deliveredToNonFollowers: 10, rechecked: 8, converted: 2, pending: 2, yieldPct: 25 }),
    );
    expect(summary?.state).toBe("measured");
    expect(summary?.yieldPct).toBe(25);
    expect(summary?.converted).toBe(2);
    expect(summary?.rechecked).toBe(8);
  });

  it("handles a zero-conversion measured window", () => {
    const summary = summarizeFollowerYield(conv({ rechecked: 5, converted: 0, yieldPct: 0 }));
    expect(summary?.state).toBe("measured");
    expect(summary?.yieldPct).toBe(0);
  });

  it("derives a percentage when the backend omits it", () => {
    const summary = summarizeFollowerYield(conv({ rechecked: 4, converted: 1, yieldPct: null }));
    expect(summary?.yieldPct).toBe(25);
  });
});
