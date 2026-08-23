import { describe, expect, it, vi } from "vitest";
import {
  createGuideAccessMetrics,
  runGuideAccessMetrics,
  type GuideAccessMetricsDb,
} from "./guideAccessMetrics.js";

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-08T00:00:00.000Z");

describe("guide access safe event recording", () => {
  it.each([
    ["opening", "accepted"],
    ["opening", "failed"],
    ["opening", "uncertain"],
    ["action", "received"],
    ["action", "replayed"],
    ["action", "expired"],
    ["action", "unsupported"],
    ["fresh_check", "follower"],
    ["fresh_check", "non_follower"],
    ["fresh_check", "unavailable"],
    ["gate", "shown"],
    ["gate", "profile_action_offered"],
    ["recheck", "attempted"],
    ["recheck", "confirmed"],
    ["recheck", "not_confirmed"],
    ["recheck", "unavailable"],
    ["delivery", "planned"],
    ["delivery", "completed"],
    ["delivery", "failed"],
    ["delivery", "needs_review"],
    ["needs_review", "marked"],
  ] as const)("records the allowlisted %s/%s aggregate outcome", async (stage, outcome) => {
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const metrics = createGuideAccessMetrics({ writeEvent });

    await expect(metrics.record({ stage, outcome, latencyMs: 125 })).resolves.toBe("recorded");
    expect(writeEvent).toHaveBeenCalledWith("guide_access_v2_metric", {
      version: 1,
      stage,
      outcome,
      latencyMs: 125,
    });
  });

  it.each([
    { stage: "fresh_check", outcome: "raw_graph_error" },
    { stage: "unknown", outcome: "accepted" },
    { stage: "opening", outcome: "accepted", latencyMs: -1 },
    { stage: "opening", outcome: "accepted", latencyMs: Number.POSITIVE_INFINITY },
    { stage: "opening", outcome: "accepted", latencyMs: 604_800_001 },
    { stage: "opening", outcome: "accepted", senderId: "account-1" },
    { stage: "opening", outcome: "accepted", username: "sarah" },
    { stage: "opening", outcome: "accepted", token: "opaque-token" },
    { stage: "opening", outcome: "accepted", copy: "private DM body" },
    { stage: "opening", outcome: "accepted", url: "https://signed.example" },
    { stage: "opening", outcome: "accepted", rawError: new Error("secret") },
    { stage: "opening", outcome: "accepted", resourceTitle: "Toddler sleep" },
  ])("rejects unsafe or unbounded event input %#", async (input) => {
    const writeEvent = vi.fn();
    const metrics = createGuideAccessMetrics({ writeEvent });

    await expect(metrics.record(input)).resolves.toBe("rejected");
    expect(writeEvent).not.toHaveBeenCalled();
  });

  it("contains event-log failures so measurement cannot break a parent action", async () => {
    const metrics = createGuideAccessMetrics({
      writeEvent: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    await expect(
      metrics.record({ stage: "delivery", outcome: "completed", latencyMs: 800 }),
    ).resolves.toBe("failed");
  });
});

describe("guide access aggregate funnel metrics", () => {
  it("returns stable zero-filled counts and bounded latency summaries", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        stage: "fresh_check",
        outcome: "follower",
        count: 3n,
        latencySamples: 2n,
        averageLatencyMs: 150.4,
        p50LatencyMs: 125.2,
        p95LatencyMs: 195.6,
        maxLatencyMs: 200,
      },
      {
        stage: "delivery",
        outcome: "completed",
        count: 2n,
        latencySamples: 2n,
        averageLatencyMs: 1000,
        p50LatencyMs: 900,
        p95LatencyMs: 1090,
        maxLatencyMs: 1100,
      },
      // Bad historical rows are ignored rather than echoed to the API.
      {
        stage: "fresh_check",
        outcome: "provider said token=https://secret",
        count: 99n,
        latencySamples: 0n,
        averageLatencyMs: null,
        p50LatencyMs: null,
        p95LatencyMs: null,
        maxLatencyMs: null,
      },
    ]);
    const result = await runGuideAccessMetrics(
      { $queryRawUnsafe: query } as GuideAccessMetricsDb,
      { from: FROM, to: TO },
    );

    expect(result).toMatchObject({
      key: "guide-access-v2",
      window: { from: FROM.toISOString(), to: TO.toISOString() },
      counts: {
        opening: { accepted: 0, failed: 0, uncertain: 0 },
        action: { received: 0, replayed: 0, expired: 0, unsupported: 0 },
        fresh_check: { follower: 3, non_follower: 0, unavailable: 0 },
        gate: { shown: 0, profile_action_offered: 0 },
        recheck: { attempted: 0, confirmed: 0, not_confirmed: 0, unavailable: 0 },
        delivery: { planned: 0, completed: 2, failed: 0, needs_review: 0 },
        needs_review: { marked: 0 },
      },
      latenciesMs: {
        fresh_check: { samples: 2, average: 150, p50: 125, p95: 196, max: 200 },
        delivery: { samples: 2, average: 1000, p50: 900, p95: 1090, max: 1100 },
      },
      totalEvents: 5,
      ownerReviewEvents: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /account-1|sarah|opaque-token|private DM body|signed\.example|Toddler sleep|provider said/i,
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining("guide_access_v2_metric"), FROM, TO);
  });

  it("clamps malformed database numerics to safe response values", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        stage: "opening",
        outcome: "accepted",
        count: -3,
        latencySamples: Number.NaN,
        averageLatencyMs: Number.POSITIVE_INFINITY,
        p50LatencyMs: -2,
        p95LatencyMs: "oops",
        maxLatencyMs: null,
      },
    ]);

    const result = await runGuideAccessMetrics(
      { $queryRawUnsafe: query } as GuideAccessMetricsDb,
      { from: FROM, to: TO },
    );

    expect(result.counts.opening.accepted).toBe(0);
    expect(result.latenciesMs.opening).toEqual({
      samples: 0,
      average: null,
      p50: null,
      p95: null,
      max: null,
    });
  });

  it("does not turn a missing latency aggregate into a misleading zero", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        stage: "opening",
        outcome: "accepted",
        count: 1n,
        latencySamples: 1n,
        averageLatencyMs: null,
        p50LatencyMs: null,
        p95LatencyMs: null,
        maxLatencyMs: null,
      },
    ]);

    const result = await runGuideAccessMetrics(
      { $queryRawUnsafe: query } as GuideAccessMetricsDb,
      { from: FROM, to: TO },
    );

    expect(result.latenciesMs.opening).toEqual({
      samples: 0,
      average: null,
      p50: null,
      p95: null,
      max: null,
    });
  });
});
