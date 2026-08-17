import { describe, expect, it } from "vitest";
import {
  composeTodaysRead,
  funnelWindowDays,
  largestMeasuredFunnelLoss,
} from "./todaysRead";
import type { ComparableWeekResult } from "./followerFlow";
import type { FunnelStageCount, GuideFollowResult } from "./types";

function stage(
  key: string,
  label: string,
  count: number,
  options: Pick<FunnelStageCount, "bypassable" | "coverageOnly"> = {},
): FunnelStageCount {
  return {
    key,
    label,
    definition: `${label} definition`,
    count,
    ofEntryPct: null,
    ofPrevPct: null,
    ...options,
  };
}

function rankedFunnel(): GuideFollowResult {
  return {
    key: "guide-follow",
    name: "Guide → follow",
    question: "Where do followers stop?",
    window: { from: "2026-07-17T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" },
    cohortSize: 100,
    stages: [
      stage("entered", "Entered", 100),
      stage("gateSent", "Gate sent", 92),
      stage("replied", "Replied", 40),
      stage("guideDelivered", "Guide delivered", 35),
      stage("followingD21", "Following at day 21", 5, { coverageOnly: true }),
    ],
    headline: {
      fromStage: "entered",
      toStage: "gateSent",
      label: "Gate-send rate",
      rationale: "Intentionally not the largest loss",
      rate: { numerator: 92, denominator: 100, pct: 92, belowMinSample: false },
    },
    followGateConversion: {
      numerator: 35,
      denominator: 40,
      pct: 87.5,
      belowMinSample: false,
    },
    stuckAtWall: 0,
    askDistribution: [],
    expressLane: 0,
    byEntryPath: [],
    retention: { numerator: 5, denominator: 5, pct: 100, belowMinSample: false },
    homeTileCohort: { deliveredToNonFollower: 0, ofWhichRedelivery: 0 },
  };
}

function readyWeek(
  overrides: Partial<Extract<ComparableWeekResult, { status: "ready" }>> = {},
): ComparableWeekResult {
  return {
    status: "ready",
    current: {
      from: "2026-08-08",
      to: "2026-08-14",
      days: [
        "2026-08-08",
        "2026-08-09",
        "2026-08-10",
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
        "2026-08-14",
      ],
      us: 248,
      coveredDays: 7,
    },
    prior: {
      from: "2026-08-01",
      to: "2026-08-07",
      days: [
        "2026-08-01",
        "2026-08-02",
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
      ],
      us: 189,
      coveredDays: 7,
    },
    changePct: 31,
    trend: "accelerating",
    ...overrides,
  };
}

function insufficientWeek(
  reason: Extract<ComparableWeekResult, { status: "insufficient" }>["reason"],
): ComparableWeekResult {
  return {
    status: "insufficient",
    reason,
    currentCoveredDays: 6,
    priorCoveredDays: 7,
  };
}

describe("funnelWindowDays", () => {
  it("reads the funnel's own window rather than assuming 30", () => {
    expect(
      funnelWindowDays({ from: "2026-07-17T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" }),
    ).toBe(30);
  });

  it("reports a short window truthfully", () => {
    expect(
      funnelWindowDays({ from: "2026-08-09T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" }),
    ).toBe(7);
  });

  it("returns null on an unusable window rather than guessing", () => {
    expect(funnelWindowDays({ from: "nonsense", to: "2026-08-16T00:00:00.000Z" })).toBeNull();
    expect(
      funnelWindowDays({ from: "2026-08-16T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" }),
    ).toBeNull();
  });
});

describe("largestMeasuredFunnelLoss", () => {
  it("ranks the largest eligible absolute stage loss", () => {
    expect(largestMeasuredFunnelLoss(rankedFunnel())).toMatchObject({
      fromStage: "gateSent",
      toStage: "replied",
      denominator: 92,
      numerator: 40,
      lost: 52,
    });
  });

  it("excludes bypassable and coverage-only transitions", () => {
    const result = rankedFunnel();
    result.stages[1]!.count = 100;
    result.stages[2]!.bypassable = true;
    result.stages[4]!.count = 0;
    expect(largestMeasuredFunnelLoss(result)?.toStage).toBe("guideDelivered");
  });

  it("keeps stage order as the tie-breaker", () => {
    const result = rankedFunnel();
    result.stages = [
      stage("entered", "Entered", 100),
      stage("gateSent", "Gate sent", 80),
      stage("replied", "Replied", 60),
    ];
    expect(largestMeasuredFunnelLoss(result)?.toStage).toBe("gateSent");
  });
});

describe("composeTodaysRead", () => {
  it("prints no interpretation for insufficient comparison evidence", () => {
    expect(composeTodaysRead(insufficientWeek("provisional_day"), rankedFunnel())).toBeNull();
  });

  it("states the change when complete comparable weeks exist", () => {
    const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
    expect(read.headline).toBe("US follower growth is 31% faster than the prior settled week.");
  });

  it("names a fall as slower rather than hiding the direction", () => {
    const read = composeTodaysRead(
      readyWeek({ changePct: -25, trend: "slowing" }),
      undefined,
    )!;
    expect(read.headline).toContain("25% slower");
  });

  it("uses a settled count, and never a percentage, when the prior total is not positive", () => {
    const read = composeTodaysRead(readyWeek({ changePct: null }), undefined)!;
    expect(read.headline).toBe("The latest settled week added 248 US followers.");
    expect(read.headline).not.toContain("%");
  });

  it("derives the week qualification from actual dates", () => {
    const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
    expect(read.headlineWindow).toBe("Aug 8–14 against Aug 1–7");
    expect(read.qualification).toContain("14 settled calendar days");
  });

  it("ranks the funnel stages instead of trusting the predefined headline", () => {
    const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
    expect(read.because).toContain("52 of 92");
    expect(read.because).toContain("gate sent and replied");
    expect(read.because).not.toContain("gate-send rate");
  });

  it("labels the funnel clause with its own real window", () => {
    const short = rankedFunnel();
    short.window = { from: "2026-08-09T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" };
    expect(composeTodaysRead(readyWeek(), short)!.becauseWindow).toBe(
      "Funnel cohort, last 7 days",
    );
  });

  it("keeps the clauses separate rather than presenting two cohorts as one finding", () => {
    const read = composeTodaysRead(readyWeek(), rankedFunnel())!;
    expect(read.because).toMatch(/^Separately,/);
    expect(read.because).not.toMatch(/^but /i);
  });

  it("omits the clause and its window together when no eligible stage loses people", () => {
    const result = rankedFunnel();
    result.stages = [stage("entered", "Entered", 100), stage("delivered", "Delivered", 100)];
    const read = composeTodaysRead(readyWeek(), result)!;
    expect(read.because).toBeNull();
    expect(read.becauseWindow).toBeNull();
  });

  it("states when the funnel's guarded headline sample is below minimum", () => {
    const result = rankedFunnel();
    result.headline.rate = { numerator: 5, denominator: 32, pct: null, belowMinSample: true };
    expect(composeTodaysRead(readyWeek(), result)!.qualification).toContain(
      "below the minimum sample",
    );
  });
});
