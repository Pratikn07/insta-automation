import { describe, expect, it } from "vitest";
import type { FollowConversion, LeaderboardRow } from "./types";
import { rankRepeatCandidates, summarizeFollowerYield } from "./homeDashboard";

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
      followThroughDays: 21,
      followThroughChecked: 0,
      stillFollowing: 0,
      unfollowed: 0,
      retentionPct: null,
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

  it("reports follow-through once enough converts have been re-measured", () => {
    // The point of the second line: 23.7% means little if those followers left.
    const s = summarizeFollowerYield(
      conv({ rechecked: 97, converted: 23, yieldPct: 23.7,
             followThroughChecked: 12, stillFollowing: 11, unfollowed: 1, retentionPct: 91.7 }),
    );
    expect(s?.retention).toContain("11 of 12");
    expect(s?.retention).toContain("21 days");
  });

  it("says nothing about follow-through before anything is re-measured", () => {
    // An absent second line is honest; "0 of 0 still following" is alarming noise.
    const s = summarizeFollowerYield(conv({ rechecked: 97, converted: 23, yieldPct: 23.7 }));
    expect(s?.retention).toBeNull();
  });

  it("stays silent when the sample is too small for a percentage", () => {
    // retentionPct null = backend judged the sample too thin; do not invent copy.
    const s = summarizeFollowerYield(
      conv({ rechecked: 97, converted: 23, yieldPct: 23.7,
             followThroughChecked: 3, stillFollowing: 2, unfollowed: 1, retentionPct: null }),
    );
    expect(s?.retention).toBeNull();
  });

  it("names the churn plainly when followers do leave", () => {
    const s = summarizeFollowerYield(
      conv({ rechecked: 97, converted: 23, yieldPct: 23.7,
             followThroughChecked: 10, stillFollowing: 4, unfollowed: 6, retentionPct: 40 }),
    );
    expect(s?.retention).toContain("4 of 10");
  });
});
