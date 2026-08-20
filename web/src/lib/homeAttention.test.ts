import { describe, expect, it } from "vitest";
import type { FollowerFlowResponse, FunnelStageCount, GuideFollowResult, Stats } from "./types";
import {
  deriveAttentionItems,
  deriveHomeAttentionState,
  type SourceState,
} from "./homeAttention";

function loading<T>(): SourceState<T> {
  return { status: "loading" };
}

function failed<T>(): SourceState<T> {
  return { status: "error" };
}

function success<T>(data: T): SourceState<T> {
  return { status: "success", data };
}

function clearStats(): Stats {
  return {
    activeKeywords: 8,
    totalKeywords: 8,
    dmsSentToday: 12,
    conversationsAwaiting: 0,
    completedToday: 9,
    lastError: null,
    gateQueuePending: 0,
    gateQueueExhausted: 0,
    gateQueueSendUncertain: 0,
    upcomingNeedsAttention: 0,
  };
}

function flowResponse(): FollowerFlowResponse {
  return {
    analyticsTimeZone: "America/Los_Angeles",
    points: [],
    stock: null,
  };
}

function stage(key: string, label: string, count: number): FunnelStageCount {
  return {
    key,
    label,
    definition: `${label} definition`,
    count,
    ofEntryPct: null,
    ofPrevPct: null,
  };
}

function clearFunnel(): GuideFollowResult {
  return {
    key: "guide-follow",
    name: "Guide → follow",
    question: "Where do followers stop?",
    window: { from: "2026-07-17T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" },
    cohortSize: 100,
    stages: [stage("entered", "Entered", 100), stage("delivered", "Delivered", 100)],
    headline: {
      fromStage: "entered",
      toStage: "delivered",
      label: "Delivery rate",
      rationale: "",
      rate: { numerator: 100, denominator: 100, pct: 100, belowMinSample: false },
    },
    followGateConversion: {
      numerator: 100,
      denominator: 100,
      pct: 100,
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

function funnelWithLoss(): GuideFollowResult {
  const result = clearFunnel();
  result.stages = [
    stage("entered", "Entered", 100),
    stage("gateSent", "Gate sent", 92),
    stage("replied", "Replied", 40),
    stage("guideDelivered", "Guide delivered", 35),
  ];
  return result;
}

describe("deriveHomeAttentionState", () => {
  it("is checking while any required source is loading and none failed", () => {
    expect(
      deriveHomeAttentionState({
        flow: loading(),
        stats: success(clearStats()),
        funnel: success(clearFunnel()),
      }),
    ).toEqual({ status: "checking" });
  });

  it("is incomplete when one source fails and keeps verified attention", () => {
    expect(
      deriveHomeAttentionState({
        flow: success(flowResponse()),
        stats: success({ ...clearStats(), gateQueueExhausted: 3 }),
        funnel: failed(),
      }),
    ).toMatchObject({
      status: "incomplete",
      failedSources: ["funnel"],
      items: [{ kind: "failed_gates" }],
    });
  });

  it("is ready_clear only after all three sources succeed with no items", () => {
    expect(
      deriveHomeAttentionState({
        flow: success(flowResponse()),
        stats: success(clearStats()),
        funnel: success(clearFunnel()),
      }),
    ).toEqual({ status: "ready_clear", items: [] });
  });

  it("is ready_with_attention when all sources succeed and verified items exist", () => {
    expect(
      deriveHomeAttentionState({
        flow: success(flowResponse()),
        stats: success({ ...clearStats(), conversationsAwaiting: 2 }),
        funnel: success(clearFunnel()),
      }),
    ).toMatchObject({
      status: "ready_with_attention",
      items: [{ kind: "conversations_awaiting" }],
    });
  });

  it("lists multiple failed sources in stable flow, stats, funnel order", () => {
    expect(
      deriveHomeAttentionState({
        flow: failed(),
        stats: success(clearStats()),
        funnel: failed(),
      }),
    ).toEqual({
      status: "incomplete",
      failedSources: ["flow", "funnel"],
      items: [],
    });
  });

  it("lets a failed source win over a source that is still loading", () => {
    expect(
      deriveHomeAttentionState({
        flow: loading(),
        stats: failed(),
        funnel: success(clearFunnel()),
      }),
    ).toEqual({ status: "incomplete", failedSources: ["stats"], items: [] });
  });
});

describe("deriveAttentionItems", () => {
  it("orders operational risk before measured loss and waiting conversations", () => {
    const items = deriveAttentionItems(
      {
        ...clearStats(),
        upcomingNeedsAttention: 1,
        gateQueueSendUncertain: 2,
        gateQueueExhausted: 3,
        conversationsAwaiting: 4,
      },
      funnelWithLoss(),
    );
    expect(items.map((item) => item.kind)).toEqual([
      "upcoming_needs_attention",
      "uncertain_gate_sends",
      "failed_gates",
      "funnel_loss",
      "conversations_awaiting",
    ]);
    expect(items[3]).toMatchObject({
      title: "Inspect the gate sent → replied loss",
      detail: expect.stringContaining("52 of 92"),
    });
  });

  /**
   * Home takes `attention[0]` as its "Best next move", so this position is a
   * product decision, not a list detail.
   *
   * An unattached keyword outranks the gate items because it is the only one where
   * the automation is not running at all: the post is live, nobody commenting on it
   * gets anything, and it keeps costing until she changes one word.
   */
  it("makes an unattached keyword the best next move when one exists", () => {
    const items = deriveAttentionItems(
      { ...clearStats(), upcomingNeedsAttention: 1, gateQueueExhausted: 12 },
      undefined,
    );

    expect(items[0]).toMatchObject({
      kind: "upcoming_needs_attention",
      title: "A keyword didn't attach to your new post",
      tag: "Now",
      to: "/content",
      action: "Fix",
    });
  });

  it("counts more than one unattached keyword in the plural", () => {
    const items = deriveAttentionItems({ ...clearStats(), upcomingNeedsAttention: 3 }, undefined);

    expect(items[0]!.title).toBe("3 keywords didn't attach to your new posts");
    expect(items[0]!.detail).toContain("Those posts published");
  });

  // A count of zero is nothing to do. A missing count is an older API build that
  // never measured it — neither may invent an item.
  it.each([{ upcomingNeedsAttention: 0 }, { upcomingNeedsAttention: undefined }])(
    "derives no upcoming item from %j",
    (patch) => {
      const items = deriveAttentionItems({ ...clearStats(), ...patch }, undefined);
      expect(items.map((item) => item.kind)).not.toContain("upcoming_needs_attention");
    },
  );

  it("derives nothing from an unavailable source", () => {
    expect(deriveAttentionItems(undefined, undefined)).toEqual([]);
  });
});
