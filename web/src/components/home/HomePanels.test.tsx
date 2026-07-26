import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import { summarizeFollowerFlow } from "@/lib/followerFlow";
import { FollowerFlowPanel } from "./FollowerFlowPanel";

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
  followersTotal: 4578,
  us: 1489,
  southAsian: 1278,
  anglosphere: 817,
  other: 724,
  countriesReported: 45,
};

describe("FollowerFlowPanel", () => {
  it("shows the region legend and chart without repeating the KPI row's numbers", () => {
    const points = [
      flowPoint("2026-07-19", { us: 10, southAsian: 3, anglosphere: 2, other: 2 }),
      flowPoint("2026-07-20", { us: 28, southAsian: 5, anglosphere: 12, other: 8 }),
      {
        ...flowPoint("2026-07-21", { us: null, southAsian: null, anglosphere: null, other: null }),
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

    expect(html).toContain("Where your new followers come from");
    expect(html).toContain("South Asia");
    expect(html).toContain("Daily net adds by region");
    expect(html).toContain("Meta did not refresh");

    // The KPI row above owns these now — printing them here too was the
    // duplication this redesign removes. Note the chart's own "Line = 7-day
    // average" caption stays, so assert on the headline's "/day" suffix
    // specifically rather than the bare substring.
    expect(html).not.toContain("Net new followers a day");
    expect(html).not.toContain(">/day<");
    expect(html).not.toContain("US share of ALL followers");
    expect(html).not.toContain("US share of NEW followers");
    expect(html).not.toContain("followers counted");
    expect(html).not.toContain("At this pace");
  });

  it("labels the y-axis so a single day's gain is readable", () => {
    const points = [
      flowPoint("2026-07-20", { us: 40, southAsian: 5, anglosphere: 10, other: 5 }),
      flowPoint("2026-07-21", { us: 120, southAsian: 15, anglosphere: 30, other: 10 }),
      flowPoint("2026-07-22", { us: 80, southAsian: 10, anglosphere: 20, other: 8 }),
      flowPoint("2026-07-23", { us: 60, southAsian: 8, anglosphere: 15, other: 6 }),
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

    // Gridline labels render as <text> inside the svg.
    expect(html).toContain("<text");
    // More than the old 3 date ticks along the bottom.
    expect((html.match(/Jul /g) ?? []).length).toBeGreaterThan(3);
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
});
