import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock, GeoWindowPoint } from "@/lib/types";
import type { AudienceGrowthSummary, RepeatCandidate } from "@/lib/homeDashboard";
import { summarizeFollowerFlow } from "@/lib/followerFlow";
import { AudienceGrowthPanel } from "./AudienceGrowthPanel";
import { FollowerFlowPanel } from "./FollowerFlowPanel";
import { RepeatReelsPanel } from "./RepeatReelsPanel";

const points: GeoWindowPoint[] = [
  {
    capturedAt: "2026-07-10T12:00:00.000Z",
    reachedUs90: 37,
    reachedUs14: 38,
    engagedUs90: 34,
    engagedUs14: 35,
    reachedIn14: 22,
    engagedIn14: 24,
  },
  {
    capturedAt: "2026-07-17T12:00:00.000Z",
    reachedUs90: 37,
    reachedUs14: 42,
    engagedUs90: 34,
    engagedUs14: 39,
    reachedIn14: 19,
    engagedIn14: 21,
  },
];

const summary: AudienceGrowthSummary = {
  status: "growing",
  source: "reached",
  currentPct: 42,
  baselinePct: 37,
  deltaPoints: 5,
  capturedAt: points[1]!.capturedAt,
  latestPoint: points[1]!,
};

const candidate: RepeatCandidate = {
  mediaId: "reel-1",
  caption: "The bedtime reset that finally worked",
  thumbnailUrl: "https://example.com/reel.jpg",
  permalink: "https://instagram.com/reel/example",
  postedAt: "2026-07-12T12:00:00.000Z",
  usFitScore: 78,
  confidence: "high",
  mediaAudioType: "original",
  videoUnavailable: false,
  analyzed: true,
  views: 12500,
  reach: 9800,
  skipRate: 0.21,
  conversion: { keywordComments: 90, gateDelivered: 70, completed: 44 },
  captureRatePct: 0.92,
  rank: 1,
  score: 92,
  reasonKey: "retention",
  reason: "People kept watching instead of skipping.",
  signals: { reach: 0.9, retention: 1, guides: 0.8 },
};

describe("AudienceGrowthPanel", () => {
  it("renders the visual growth verdict and honest comparison language", () => {
    const html = renderToStaticMarkup(
      <AudienceGrowthPanel
        points={points}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Is my US audience growing?");
    expect(html).toContain("Growing");
    expect(html).toContain("42.0%");
    expect(html).toContain("+5.0 percentage points");
    expect(html).toContain("Recent 14 days");
    expect(html).toContain("90-day baseline");
    expect(html).toContain("US audience trend");
    expect(html).toContain("width:42%");
    expect(html).toContain("width:37%");
  });
});

describe("RepeatReelsPanel", () => {
  it("renders a visual, performance-led repeat recommendation", () => {
    const html = renderToStaticMarkup(
      <RepeatReelsPanel
        candidates={[candidate]}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Which reels should I repeat?");
    expect(html).toContain("The bedtime reset that finally worked");
    expect(html).toContain("9.8K");
    expect(html).toContain("21% skip");
    expect(html).toContain("44 guides");
    expect(html).toContain("US fit 78");
    expect(html).toContain("People kept watching instead of skipping.");
    expect(html).toContain("Open reel on Instagram");
    expect(html).toContain("US-fit is context, not part of the ranking");
  });
});

function flowPoint(
  day: string,
  overrides: Partial<FollowerDailyAddsPoint> = {},
): FollowerDailyAddsPoint {
  const total =
    (overrides.us ?? 0) + (overrides.southAsian ?? 0) + (overrides.anglosphere ?? 0) + (overrides.other ?? 0);
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: 0,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
    ...overrides,
  };
}

const flowStock: FollowerStock = {
  capturedAt: "2026-07-25T23:24:27.681Z",
  totalCounted: 4308,
  us: 1489,
  southAsian: 1278,
  anglosphere: 817,
  other: 724,
  countriesReported: 45,
};

describe("FollowerFlowPanel", () => {
  it("leads with the per-day rate and contrasts new-follower US share with stock share", () => {
    const points = [
      flowPoint("2026-07-19", { us: 10, southAsian: 3, anglosphere: 2, other: 2 }),
      flowPoint("2026-07-20", { us: 28, southAsian: 5, anglosphere: 12, other: 8 }),
      {
        ...flowPoint("2026-07-21", {
          us: null,
          southAsian: null,
          anglosphere: null,
          other: null,
        }),
        total: null,
        spanDays: null,
        reportedTotalDelta: null,
        unattributed: null,
        stale: true,
        basis: "stale" as const,
      },
      flowPoint("2026-07-22", {
        us: 118,
        southAsian: 20,
        anglosphere: 20,
        other: 10,
        spanDays: 2,
        basis: "multi_day_span",
      }),
    ];
    const summary = summarizeFollowerFlow(points)!;

    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("How many new followers a day?");
    // 238 adds over 4 covered days = 60/day — days covered, not points counted.
    expect(html).toContain("+60");
    expect(html).toContain("US share of NEW followers (7d)");
    expect(html).toContain("66%"); // 156 of 238
    expect(html).toContain("US share of ALL followers");
    expect(html).toContain("35%"); // 1489 of 4308
    expect(html).toContain("4,308");
    expect(html).toContain("followers counted");
    expect(html).toContain("Meta did not refresh");
    expect(html).toContain("South Asia");
  });

  it("counts still-settling days in the headline and says so in the label", () => {
    const points = [
      flowPoint("2026-07-24", { us: 100 }),
      flowPoint("2026-07-25", { us: 100 }),
      flowPoint("2026-07-26", { us: 10, provisional: true }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    // 210 over 3 days = 70. Dropping the provisional day would print +100 next
    // to a legend that sums 210 — so the day counts, and the label discloses it.
    // Match the headline element, not bare "+100": the chart tooltips legitimately
    // say "+100 net" for the two settled bars.
    const headline = html.match(/text-6xl[^>]*>([^<]*)</)?.[1];
    expect(headline).toBe("+70");
    expect(html).toContain("newest 1 still settling");
  });

  it("omits the settling note when every day in the window is settled", () => {
    const points = [
      flowPoint("2026-07-24", { us: 20 }),
      flowPoint("2026-07-25", { us: 30 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).not.toContain("still settling");
  });

  it("shows the waiting state before two measured days exist", () => {
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={[]}
        stock={null}
        summary={null}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("Waiting for follower snapshots");
  });

  it("surfaces unattributed rank-churn as an honest footnote when non-zero", () => {
    const points = [
      flowPoint("2026-07-24", { us: 20, other: 5 }),
      flowPoint("2026-07-25", { us: 30, other: 5, unattributed: 7 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain("+7 more Meta counted");
    expect(html).toContain("top-45 reporting cutoff");
  });

  it("warns when the follower feed itself has gone stale", () => {
    const points = [
      flowPoint("2026-07-19", { us: 20 }),
      flowPoint("2026-07-20", { us: 30 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={{ ...flowStock, capturedAt: "2026-07-20T23:00:00.000Z" }}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        now="2026-07-25T12:00:00.000Z"
      />,
    );
    expect(html).toContain("Snapshots");
    expect(html).toContain("days old");
  });

  it("stays quiet when the follower feed is fresh", () => {
    const points = [
      flowPoint("2026-07-24", { us: 20 }),
      flowPoint("2026-07-25", { us: 30 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={{ ...flowStock, capturedAt: "2026-07-25T06:00:00.000Z" }}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        now="2026-07-25T12:00:00.000Z"
      />,
    );
    expect(html).not.toContain("Snapshots as of");
  });
});

describe("AudienceGrowthPanel staleness pill", () => {
  it("labels the panel with its feed age when the feed is stale", () => {
    const html = renderToStaticMarkup(
      <AudienceGrowthPanel
        points={points}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        asOf="2026-07-17T12:00:00.000Z"
      />,
    );
    expect(html).toContain("days old");
  });
});
