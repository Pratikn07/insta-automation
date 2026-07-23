import { describe, expect, it } from "vitest";
import type { Experiment, LeaderboardRow } from "./types";
import {
  learnedPatterns,
  rankCaptureLeaders,
  recommendNextTest,
  formatCaptureRate,
} from "./growthLab";

function experiment(overrides: Partial<Experiment> & Pick<Experiment, "id">): Experiment {
  const { id, ...rest } = overrides;
  return {
    id,
    hypothesis: "Does this shift engaged-US%?",
    variable: "content",
    reelMediaIds: [id],
    status: "running",
    baselineUsPct: null,
    measuredUsPct: null,
    currentUsPct: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    postedAt: "2026-07-01T00:00:00.000Z",
    conclusion: null,
    origin: "auto",
    mediaId: id,
    usFitScore: 70,
    culturalCues: [],
    baselineEngagedUsPct: 40,
    measuredEngagedUsPct: 45,
    windowReachShare: 0.6,
    suggestedVerdict: "confirmed",
    attributionConfidence: "high",
    hookArchetype: "question",
    audioVibe: null,
    onScreenLang: null,
    ...rest,
  };
}

function reel(
  overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, "mediaId">,
): LeaderboardRow {
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
    reach: 5000,
    skipRate: null,
    conversion: { keywordComments: 0, gateDelivered: 0, completed: 0 },
    captureRatePct: null,
    ...rest,
  };
}

describe("rankCaptureLeaders", () => {
  it("returns nothing when no reel clears the reach floor (all capture rates null)", () => {
    expect(rankCaptureLeaders([reel({ mediaId: "a" }), reel({ mediaId: "b" })])).toEqual([]);
  });

  it("ranks eligible reels by capture rate and caps at three", () => {
    const leaders = rankCaptureLeaders([
      reel({ mediaId: "low", captureRatePct: 0.1 }),
      reel({ mediaId: "top", captureRatePct: 1.4 }),
      reel({ mediaId: "mid", captureRatePct: 0.5 }),
      reel({ mediaId: "tiny", captureRatePct: 0.05 }),
    ]);
    expect(leaders.map((l) => l.row.mediaId)).toEqual(["top", "mid", "low"]);
    expect(leaders[0].rank).toBe(1);
  });

  it("calls out a multiple of the median when a reel converts at least 2x", () => {
    const leaders = rankCaptureLeaders([
      reel({ mediaId: "star", captureRatePct: 1.4 }),
      reel({ mediaId: "typical", captureRatePct: 0.2 }),
      reel({ mediaId: "typical2", captureRatePct: 0.2 }),
    ]);
    expect(leaders[0].multipleOfMedian).toBe(7);
    expect(leaders[0].reason).toContain("×");
  });

  it("uses generic praise when the top reel is under 2x the median", () => {
    const leaders = rankCaptureLeaders([
      reel({ mediaId: "a", captureRatePct: 0.5 }),
      reel({ mediaId: "b", captureRatePct: 0.45 }),
      reel({ mediaId: "c", captureRatePct: 0.4 }),
    ]);
    expect(leaders[0].reason).not.toContain("×");
  });

  it("breaks capture-rate ties by newest post", () => {
    const leaders = rankCaptureLeaders([
      reel({ mediaId: "older", captureRatePct: 0.5, postedAt: "2026-06-01T00:00:00.000Z" }),
      reel({ mediaId: "newer", captureRatePct: 0.5, postedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(leaders.map((l) => l.row.mediaId)).toEqual(["newer", "older"]);
  });
});

describe("formatCaptureRate", () => {
  it("renders two decimals with a percent sign", () => {
    expect(formatCaptureRate(1.39)).toBe("1.39%");
    expect(formatCaptureRate(0.2)).toBe("0.20%");
  });
});

describe("recommendNextTest", () => {
  it("stays in collecting with no measured experiments", () => {
    const rec = recommendNextTest([]);
    expect(rec.status).toBe("collecting");
    expect(rec.headline).toContain("No measured experiments");
  });

  it("recommends a feature once two usable positive validations agree", () => {
    const rec = recommendNextTest([
      experiment({ id: "a", hookArchetype: "question", baselineEngagedUsPct: 40, measuredEngagedUsPct: 46 }),
      experiment({
        id: "b",
        hookArchetype: "question",
        attributionConfidence: "medium",
        baselineEngagedUsPct: 42,
        measuredEngagedUsPct: 45,
      }),
    ]);
    expect(rec.status).toBe("recommended");
    expect(rec.pattern?.feature).toBe("question");
    expect(rec.pattern?.total).toBe(2);
    expect(rec.headline).toContain("question");
  });

  it("excludes low-confidence experiments from the evidence", () => {
    const rec = recommendNextTest([
      experiment({ id: "a", hookArchetype: "question", baselineEngagedUsPct: 40, measuredEngagedUsPct: 46 }),
      experiment({
        id: "b",
        hookArchetype: "question",
        attributionConfidence: "low",
        baselineEngagedUsPct: 42,
        measuredEngagedUsPct: 48,
      }),
    ]);
    // Only one usable validation → cannot recommend yet.
    expect(rec.status).toBe("collecting");
    expect(rec.needMore).toBe(1);
  });

  it("labels a consistently negative feature as rethink and does not recommend it", () => {
    const patterns = learnedPatterns([
      experiment({ id: "a", hookArchetype: "shock", baselineEngagedUsPct: 45, measuredEngagedUsPct: 40 }),
      experiment({ id: "b", hookArchetype: "shock", baselineEngagedUsPct: 44, measuredEngagedUsPct: 41 }),
    ]);
    const shock = patterns.find((p) => p.feature === "shock");
    expect(shock?.label).toBe("rethink");
    expect(recommendNextTest([]).status).toBe("collecting");
  });
});
