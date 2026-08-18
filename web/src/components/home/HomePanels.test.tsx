import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import { summarizeFollowerFlow } from "@/lib/followerFlow";
import { FollowerFlowPanel } from "./FollowerFlowPanel";
import { CHART_MEAN, CHART_PROVISIONAL, REGION_CHART_COLORS } from "@/lib/chartPalette";

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
    expect(html).toContain("bucketed by Pacific day");
    expect(html).not.toContain("bucketed by UTC day");
    // The "Meta did not refresh" caveat used to appear here because it lived in
    // a per-bar <title>. It is now hover-only, covered by chartTooltip.test.ts;
    // the panel's own footer keeps the standing version of the caveat.
    expect(html).toContain("days Meta skips are absorbed into the next bar");

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

  it("drops the slow native per-bar tooltips but keeps the chart's own labels", () => {
    const points = [
      flowPoint("2026-07-20", { us: 40, southAsian: 5, anglosphere: 10, other: 5 }),
      flowPoint("2026-07-21", { us: 120, southAsian: 15, anglosphere: 30, other: 10 }),
      flowPoint("2026-07-22", { us: 80, southAsian: 10, anglosphere: 20, other: 8 }),
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

    // The old native tooltips said "net." per bar — those are gone.
    expect(html).not.toContain("net.");
    // Exactly two <title>s survive: the chart's own, and the mean line's.
    expect((html.match(/<title>/g) ?? []).length).toBe(2);
    expect(html).toContain("<title>Daily net follower adds by region</title>");
    expect(html).toContain("7-day rolling average per day");
    // The accessible summary is untouched.
    expect(html).toContain('role="img"');
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

  it("makes every rendered chart day keyboard-selectable, including a ghost day", () => {
    const points = [
      flowPoint("2026-08-01", { us: 20 }),
      flowPoint("2026-08-02", { us: 30 }),
      flowPoint("2026-08-03", { us: 40 }),
      {
        ...flowPoint("2026-08-04", {
          us: null,
          southAsian: null,
          anglosphere: null,
          other: null,
        }),
        total: null,
        reportedTotalDelta: null,
        unattributed: null,
        spanDays: null,
        stale: true,
        provisional: true,
        basis: "pending" as const,
      },
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
        selectedDay="2026-08-03"
        onDaySelect={() => undefined}
      />,
    );

    expect((html.match(/role="button"/g) ?? [])).toHaveLength(4);
    expect((html.match(/tabindex="0"/g) ?? [])).toHaveLength(4);
    expect((html.match(/data-day-hit-target=/g) ?? [])).toHaveLength(4);
    expect((html.match(/pointer-events="all"/g) ?? [])).toHaveLength(4);
    expect(html).toContain("View feed-post attribution for August 1, 2026");
    expect(html).toContain("View feed-post attribution for August 4, 2026");
    expect(html).toContain('aria-label="View feed-post attribution for August 3, 2026" aria-pressed="true"');
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

/**
 * The chart's marks, measured in the rendered SVG rather than trusted from the
 * palette module. The palette can be correct while the component still paints a
 * white stroke or fades a group — which is exactly what it did.
 */
describe("follower chart marks on paper", () => {
  const points = [
    flowPoint("2026-08-10", { us: 12, southAsian: 4, anglosphere: 3, other: 2 }),
    flowPoint("2026-08-11", { us: 9, southAsian: 5, anglosphere: 2, other: 1 }),
    flowPoint("2026-08-12", { us: 14, southAsian: 3, anglosphere: 4, other: 2 }),
    flowPoint("2026-08-13", { us: 11, southAsian: 6, anglosphere: 1, other: 3 }),
    flowPoint("2026-08-14", { us: 8, southAsian: 2, anglosphere: 5, other: 1 }),
    flowPoint("2026-08-15", { us: 13, southAsian: 4, anglosphere: 2, other: 2 }),
    flowPoint("2026-08-16", { us: 10, southAsian: 3, anglosphere: 3, other: 1 }),
    // The last window is still filling, which used to be shown by fading it.
    flowPoint("2026-08-17", { us: 5, southAsian: 1, anglosphere: 1, other: 0, provisional: true }),
  ];

  function markup(selectedDay: string | null = null) {
    return renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summarizeFollowerFlow(points)}
        selectedDay={selectedDay}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );
  }

  it("paints no white stroke or fill anywhere in the chart", () => {
    const html = markup();

    // Semi-transparent white was the mean line and the provisional outline. On
    // #fffef9 that is about 1.05:1 — not dim, absent.
    expect(html).not.toContain("255 255 255");
    expect(html).not.toMatch(/stroke="white"/);
    expect(html).not.toMatch(/stroke="#fff/i);
  });

  it("draws the rolling mean in near-ink", () => {
    expect(markup()).toContain(`stroke="${CHART_MEAN}"`);
  });

  it("marks a provisional window with a dash rather than a fade", () => {
    const html = markup();

    expect(html).toContain('stroke-dasharray="3 3"');
    expect(html).toContain(`stroke="${CHART_PROVISIONAL}"`);
  });

  it("leaves every semantic mark fully opaque", () => {
    for (const html of [markup(), markup("2026-08-12"), markup("2026-08-17")]) {
      // Any opacity below 1 on a bar group or its rects is the regression: it
      // pushed those marks under the 3:1 floor their colour was chosen to clear.
      const faded = html.match(/\sopacity="0(\.\d+)?"/g) ?? [];
      expect(faded).toEqual([]);
    }
  });

  it("uses the paper region colours, not the dark-ground tints", () => {
    const html = markup();

    expect(html).toContain(REGION_CHART_COLORS.us);
    expect(html).toContain(REGION_CHART_COLORS.southAsian);
    // emerald-400 / violet-400, the values that measured ~1.5:1 here.
    expect(html).not.toContain("52 211 153");
    expect(html).not.toContain("167 139 250");
  });
});
