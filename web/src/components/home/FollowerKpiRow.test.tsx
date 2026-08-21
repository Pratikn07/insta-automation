import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock, GuideFollowResult, Stats } from "@/lib/types";
import type { ComparableWeekResult } from "@/lib/followerFlow";
import { FollowerKpiRow } from "./FollowerKpiRow";

// Only the third tile reads this, and only its headline. Everything else is
// present so the fixture matches the real API response shape.
const funnel = {
  key: "guide-follow",
  name: "Guide → follow",
  question: "",
  window: { from: "2026-07-15T00:00:00.000Z", to: "2026-08-14T00:00:00.000Z" },
  cohortSize: 3383,
  stages: [],
  headline: {
    fromStage: "gateSent",
    toStage: "replied",
    label: "Reply rate",
    rationale: "",
    rate: { numerator: 1589, denominator: 3360, pct: 47.3, belowMinSample: false },
  },
  followGateConversion: { numerator: 202, denominator: 270, pct: 74.8, belowMinSample: false },
  stuckAtWall: 68,
  askDistribution: [],
  expressLane: 1355,
  byEntryPath: [],
  retention: { numerator: 5, denominator: 5, pct: 100, belowMinSample: false },
  homeTileCohort: { deliveredToNonFollower: 29, ofWhichRedelivery: 1 },
} satisfies GuideFollowResult;

const stock: FollowerStock = {
  capturedAt: "2026-07-25T23:24:27.681Z",
  totalCounted: 4355,
  followersTotal: 4578,
  us: 1489,
  southAsian: 1278,
  anglosphere: 817,
  other: 771,
  countriesReported: 45,
};

// Ten trailing days for the score's series: eight measured, one still
// provisional, and one Meta never measured. The unmeasured day must draw nothing
// rather than a zero-height bar, and it must still be counted in the caption.
const points: FollowerDailyAddsPoint[] = [
  { day: "2026-07-16", us: 40, basis: "diff", provisional: false },
  { day: "2026-07-17", us: 62, basis: "diff", provisional: false },
  { day: "2026-07-18", us: -8, basis: "diff", provisional: false },
  { day: "2026-07-19", us: 91, basis: "diff", provisional: false },
  { day: "2026-07-20", us: null, basis: "no_snapshot", provisional: false },
  { day: "2026-07-21", us: 55, basis: "diff", provisional: false },
  { day: "2026-07-22", us: 73, basis: "multi_day_span", provisional: false },
  { day: "2026-07-23", us: 48, basis: "diff", provisional: false },
  { day: "2026-07-24", us: 66, basis: "diff", provisional: false },
  { day: "2026-07-25", us: 31, basis: "diff", provisional: true },
].map((p) => ({
  ...p,
  capturedAt: `${p.day}T23:00:00.000Z`,
  southAsian: 0,
  anglosphere: 0,
  other: 0,
  total: p.us,
  unattributed: 0,
  reportedTotalDelta: p.us,
  spanDays: 1,
  stale: false,
})) as FollowerDailyAddsPoint[];

const stats: Stats = {
  activeKeywords: 8,
  totalKeywords: 10,
  dmsSentToday: 16,
  conversationsAwaiting: 5,
  completedToday: 12,
  lastError: null,
  gateQueuePending: 2,
  gateQueueExhausted: 0,
  followConversion: {
    windowDays: 30,
    deliveredToNonFollowers: 112,
    rechecked: 112,
    converted: 25,
    pending: 0,
    yieldPct: 22.3,
    followThroughDays: 21,
    followThroughChecked: 12,
    stillFollowing: 11,
    unfollowed: 1,
    retentionPct: 91.7,
  },
};

const comparison: ComparableWeekResult = {
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
    us: 182,
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
    us: 140,
    coveredDays: 7,
  },
  changePct: 30,
  trend: "accelerating",
};

const insufficient: ComparableWeekResult = {
  status: "insufficient",
  reason: "provisional_day",
  currentCoveredDays: 5,
  priorCoveredDays: 7,
};

describe("FollowerKpiRow", () => {
  it("answers US growth in real counts, not percentage points", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );

    expect(html).toContain("US followers this week");
    expect(html).toContain("+182");
    expect(html).toContain("vs +140 in the prior settled week");
    expect(html).not.toContain("percentage points");
  });

  it("withholds an interpretive count while the newest measurements are settling", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={insufficient}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Newest measurements are still settling");
    expect(html).not.toContain("+182");
  });

  it("withholds the comparison when there is not enough history", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={{
          ...insufficient,
          reason: "not_enough_history",
          currentCoveredDays: 7,
          priorCoveredDays: 4,
        }}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Waiting for two complete settled weeks");
    expect(html).not.toContain("vs +140 last week");
  });

  it("shows the total-follower milestone and its pace", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("4,355");
    expect(html).toContain("5,000");
    expect(html).toContain("At this pace");
  });

  it("keeps the all-regions daily rate that the trimmed chart panel gave up", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    // "How many followers were added a day" is a must-have; trimming the panel
    // removed its +108/day headline, so this tile has to carry it.
    expect(html).toContain("+108/day all regions");
  });

  it("shows Instagram's real follower count, disclosing the reported subtotal", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={91}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("4,578");
    // The 45-country number stays visible — we added a truer number, not hid one.
    expect(html).toContain("4,355 across Meta&#x27;s 45 reported countries");
  });

  it("falls back to the reported subtotal when the profile fetch failed", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={{ ...stock, followersTotal: null }}
        avgPerDay7={91}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("4,355");
    expect(html).toContain("Counted across Meta&#x27;s 45 reported countries");
  });

  it("leads the third tile with the reply rate and its counts", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Reply rate");
    expect(html).toContain("47.3%");
    expect(html).toContain("1,589 of 3,360");
    // The loss is what a reader can act on, so it travels with the rate.
    expect(html).toContain("1,771 never replied");
  });

  it("no longer reports the retired guide-to-follow yield", () => {
    // The hard follow gate drained that tile's cohort to zero. Reviving it
    // would put a number on Home that the data can no longer support.
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).not.toContain("22.3%");
    expect(html).not.toContain("non-followers followed");
  });

  it("degrades each tile independently when its feed is missing", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={{
          status: "insufficient",
          reason: "not_enough_history",
          currentCoveredDays: 0,
          priorCoveredDays: 0,
        }}
        stock={null}
        avgPerDay7={null}
        stats={undefined}
        funnel={undefined}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Waiting for two complete settled weeks");
    expect(html).toContain("Reply rate is temporarily unavailable");
    expect(html).toContain("—");
  });
});

describe("FollowerKpiRow reply-rate tile", () => {
  it("puts the counts in the value slot when the sample is too thin to rate", () => {
    // Mirrors GuardedNumber on the Funnels page: a suppressed percentage must
    // never come back as a bare dash, which reads as "broken" rather than
    // "not enough data".
    const thin = {
      ...funnel,
      headline: {
        ...funnel.headline,
        rate: { numerator: 2, denominator: 4, pct: null, belowMinSample: true },
      },
    } satisfies GuideFollowResult;

    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={thin}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("2 of 4");
    expect(html).not.toContain("50%");
    // A meter is a number drawn as length. A half-filled bar beside "2 of 4"
    // would state the very percentage the text withholds, so the mark is
    // withheld too — no funnel fill anywhere in the row.
    expect(html).not.toContain("bg-funnel-mark");
  });

  it("draws the reply meter once the rate clears the minimum sample", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        points={points}
        weekComparison={comparison}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("bg-funnel-mark");
  });

  describe("the score's daily series", () => {
    it("draws nothing for a day Meta never measured, rather than a zero bar", () => {
      const html = renderToStaticMarkup(
        <FollowerKpiRow
          points={points}
          weekComparison={comparison}
          stock={stock}
          avgPerDay7={108}
          stats={stats}
          funnel={funnel}
          isFlowLoading={false}
          isStatsLoading={false}
          isFunnelLoading={false}
        />,
      );
      // Ten slots, one of them basis "no_snapshot" — so nine bars, not ten. A
      // tenth bar of zero height would say nobody followed that day, which is
      // the one thing the data does not say.
      const bars = html.match(/<rect /g) ?? [];
      expect(bars).toHaveLength(9);
    });

    it("marks a still-settling day with the provisional colour, not the US series", () => {
      const html = renderToStaticMarkup(
        <FollowerKpiRow
          points={points}
          weekComparison={comparison}
          stock={stock}
          avgPerDay7={108}
          stats={stats}
          funnel={funnel}
          isFlowLoading={false}
          isStatsLoading={false}
          isFunnelLoading={false}
        />,
      );
      expect(html).toContain("var(--color-chart-provisional)");
      // And the accent is never a data series colour, per index.css.
      expect(html).not.toContain("var(--color-signal)");
    });

    it("says how much of the window was measured when the week cannot be compared", () => {
      const html = renderToStaticMarkup(
        <FollowerKpiRow
          points={points}
          weekComparison={insufficient}
          stock={stock}
          avgPerDay7={108}
          stats={stats}
          funnel={funnel}
          isFlowLoading={false}
          isStatsLoading={false}
          isFunnelLoading={false}
        />,
      );
      // The cell keeps its series so it is not an empty hole, but it never sums
      // the measured days into a stand-in for the withheld figure.
      expect(html).toContain("9 of the last 10 days measured");
      expect(html).toContain("<rect ");
      expect(html).not.toContain("+182");
    });

    it("omits the series entirely when no day has been measured", () => {
      const html = renderToStaticMarkup(
        <FollowerKpiRow
          points={points.map((p) => ({ ...p, us: null, basis: "no_snapshot" as const }))}
          weekComparison={insufficient}
          stock={stock}
          avgPerDay7={108}
          stats={stats}
          funnel={funnel}
          isFlowLoading={false}
          isStatsLoading={false}
          isFunnelLoading={false}
        />,
      );
      // An axis with no bars is a chart claiming a series it does not have.
      expect(html).not.toContain("<rect ");
    });
  });
});
