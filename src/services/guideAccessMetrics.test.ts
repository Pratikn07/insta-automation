import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GUIDE_ACCESS_AGGREGATE_SQL,
  GUIDE_ACCESS_OUTCOMES,
  createGuideAccessMetrics,
  runGuideAccessMetrics,
  type GuideAccessMetricsDb,
} from "./guideAccessMetrics.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
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
    ["cover", "selected"],
    ["cover", "accepted"],
    ["cover", "failed"],
    ["cover", "uncertain"],
    ["cover", "omitted_already_shown"],
    ["cover", "omitted_not_selected"],
    ["cover", "omitted_mismatch"],
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

// Parent-delivery Task 7. Percentages are computed here, not in the page, so the dashboard
// and `npm run funnel` cannot disagree about the arithmetic.
describe("guide cover rates", () => {
  function coverRows(counts: Record<string, number>) {
    return Object.entries(counts).map(([outcome, count]) => ({
      stage: "cover",
      outcome,
      count: BigInt(count),
      latencySamples: 0n,
      averageLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      maxLatencyMs: null,
    }));
  }

  async function run(counts: Record<string, number>) {
    const query = vi.fn().mockResolvedValue(coverRows(counts));
    return runGuideAccessMetrics({ $queryRawUnsafe: query } as GuideAccessMetricsDb, {
      from: FROM,
      to: TO,
    });
  }

  it("rates exposure against the covers that actually entered a plan", async () => {
    const result = await run({
      selected: 20,
      accepted: 17,
      failed: 2,
      uncertain: 1,
      omitted_already_shown: 4,
      omitted_not_selected: 70,
      omitted_mismatch: 6,
    });

    // `selected` is the denominator for exposure: a cover that was never put into a plan
    // cannot have been accepted or refused by the provider.
    expect(result.coverRates.accepted).toEqual({
      numerator: 17,
      denominator: 20,
      pct: 85,
      belowMinSample: false,
    });
    expect(result.coverRates.failed).toMatchObject({ denominator: 20, pct: 10 });
    expect(result.coverRates.uncertain).toMatchObject({ denominator: 20, pct: 5 });
  });

  it("rates inclusion against every delivery that had a cover to consider", async () => {
    const result = await run({
      selected: 20,
      accepted: 20,
      failed: 0,
      uncertain: 0,
      omitted_already_shown: 4,
      omitted_not_selected: 70,
      omitted_mismatch: 6,
    });

    // 20 + 4 + 70 + 6. The four outcomes partition the pool, so this denominator is the
    // whole of it and the shares below can be read against each other.
    expect(result.coverRates.included).toMatchObject({ numerator: 20, denominator: 100, pct: 20 });
    expect(result.coverRates.duplicateSuppressed).toMatchObject({
      numerator: 4,
      denominator: 100,
      pct: 4,
    });
    expect(result.coverRates.mispaired).toMatchObject({ numerator: 6, denominator: 100, pct: 6 });
  });

  it("withholds a percentage the sample cannot support", async () => {
    const result = await run({ selected: 3, accepted: 2, failed: 1, uncertain: 0 });

    // A rate over three sends is an invitation to a decision the sample cannot carry.
    expect(result.coverRates.accepted).toEqual({
      numerator: 2,
      denominator: 3,
      pct: null,
      belowMinSample: true,
    });
  });

  it("reports nothing measured rather than zero when no cover was considered", async () => {
    const result = await run({});

    expect(result.coverRates.included).toEqual({
      numerator: 0,
      denominator: 0,
      pct: null,
      belowMinSample: true,
    });
  });

  it("does not accumulate a duplicated stage row into an inflated count", async () => {
    const query = vi.fn().mockResolvedValue([
      ...coverRows({ selected: 10, accepted: 10 }),
      // A replayed exposure is fenced by `claimCoverExposure`, so this row should not
      // exist. If it ever does, the reader must not double it into a 200% acceptance rate.
      ...coverRows({ accepted: 10 }),
    ]);

    const result = await runGuideAccessMetrics(
      { $queryRawUnsafe: query } as GuideAccessMetricsDb,
      { from: FROM, to: TO },
    );

    expect(result.counts.cover.accepted).toBe(10);
    expect(result.coverRates.accepted.pct).toBe(100);
  });
});

// Parent-delivery Task 7, self-review. The aggregate SQL carries a SECOND copy of the
// stage/outcome vocabulary as a hand-written WHERE clause. Every test above mocks
// `$queryRawUnsafe`, so they fed the reader fabricated rows and never once exercised that
// filter — which is how the `cover` stage came to be recorded by the writer and discarded
// by the query, reading zero forever. These two tests close that gap from both sides.
describe("aggregate SQL vocabulary", () => {
  it("admits every stage the writer is allowed to record", () => {
    const missing = Object.keys(GUIDE_ACCESS_OUTCOMES).filter(
      (stage) => !GUIDE_ACCESS_AGGREGATE_SQL.includes(`'${stage}'`),
    );

    expect(missing).toEqual([]);
  });

  it("admits every outcome the writer is allowed to record", () => {
    const missing = Object.entries(GUIDE_ACCESS_OUTCOMES).flatMap(([stage, outcomes]) =>
      (outcomes as readonly string[])
        .filter((outcome) => !GUIDE_ACCESS_AGGREGATE_SQL.includes(`'${outcome}'`))
        .map((outcome) => `${stage}/${outcome}`),
    );

    expect(missing).toEqual([]);
  });
});

// The test that would have caught it. Every test above this point mocks the query, so none
// of them can tell a valid SQL string from a correct one. This one writes a real event per
// (stage, outcome) in the vocabulary and reads it back through the real SQL.
describeWithDatabase("aggregate SQL against PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    expect(process.env.DATABASE_URL).toBe(databaseUrl);
    expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("returns every stage and outcome the writer is allowed to record", async () => {
    const pairs = Object.entries(GUIDE_ACCESS_OUTCOMES).flatMap(([stage, outcomes]) =>
      (outcomes as readonly string[]).map((outcome) => ({ stage, outcome })),
    );
    const marker = new Date("2026-08-23T06:00:00.000Z");
    await prisma.eventLog.deleteMany({ where: { kind: "guide_access_v2_metric" } });
    await prisma.eventLog.createMany({
      data: pairs.map(({ stage, outcome }) => ({
        kind: "guide_access_v2_metric",
        payload: { version: 1, stage, outcome, latencyMs: 100 },
        createdAt: marker,
      })),
    });

    try {
      const result = await runGuideAccessMetrics(prisma, {
        from: new Date(marker.getTime() - 1_000),
        to: new Date(marker.getTime() + 1_000),
      });

      const dropped = pairs.filter(({ stage, outcome }) => {
        const counts = result.counts[stage as keyof typeof result.counts] as Record<string, number>;
        return counts[outcome] !== 1;
      });
      expect(dropped).toEqual([]);
      expect(result.totalEvents).toBe(pairs.length);
      // And the derived rates really are computed off rows that survived the filter.
      expect(result.coverRates.included.denominator).toBe(4);
    } finally {
      await prisma.eventLog.deleteMany({ where: { kind: "guide_access_v2_metric" } });
    }
  });
});
