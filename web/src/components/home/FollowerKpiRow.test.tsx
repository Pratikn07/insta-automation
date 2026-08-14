import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerStock, GuideFollowResult, Stats } from "@/lib/types";
import type { UsWeekOverWeek } from "@/lib/followerFlow";
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

const wow: UsWeekOverWeek = {
  thisWeek: 182,
  lastWeek: 140,
  deltaCount: 42,
  trend: "accelerating",
  coveredDays: 7,
  provisionalDays: 0,
};

describe("FollowerKpiRow", () => {
  it("answers US growth in real counts, not percentage points", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
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
    expect(html).toContain("vs +140 last week");
    expect(html).not.toContain("percentage points");
  });

  it("discloses still-settling days rather than hiding them", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={{ ...wow, provisionalDays: 2 }}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("newest 2 still settling");
  });

  it("withholds the comparison when there is not enough history", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={{ ...wow, lastWeek: null, deltaCount: null, trend: "steady" }}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        funnel={funnel}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Not enough history yet for a week-over-week read");
    expect(html).not.toContain("vs +140 last week");
  });

  it("shows the total-follower milestone and its pace", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
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
        weekOverWeek={wow}
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
        weekOverWeek={wow}
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
        weekOverWeek={wow}
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
        weekOverWeek={wow}
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
        weekOverWeek={wow}
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
        weekOverWeek={null}
        stock={null}
        avgPerDay7={null}
        stats={undefined}
        funnel={undefined}
        isFlowLoading={false}
        isStatsLoading={false}
        isFunnelLoading={false}
      />,
    );
    expect(html).toContain("Needs two days of follower geography");
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
        weekOverWeek={wow}
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
  });
});
