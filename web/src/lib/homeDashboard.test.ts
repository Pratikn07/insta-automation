import { describe, expect, it } from "vitest";
import type { LeaderboardRow } from "./types";
import { rankRepeatCandidates } from "./homeDashboard";

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
