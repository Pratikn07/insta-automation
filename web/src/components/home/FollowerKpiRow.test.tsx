import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerStock, Stats } from "@/lib/types";
import type { UsWeekOverWeek } from "@/lib/followerFlow";
import { FollowerKpiRow } from "./FollowerKpiRow";

const stock: FollowerStock = {
  capturedAt: "2026-07-25T23:24:27.681Z",
  totalCounted: 4355,
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
        isFlowLoading={false}
        isStatsLoading={false}
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
        isFlowLoading={false}
        isStatsLoading={false}
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
        isFlowLoading={false}
        isStatsLoading={false}
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
        isFlowLoading={false}
        isStatsLoading={false}
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
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    // "How many followers were added a day" is a must-have; trimming the panel
    // removed its +108/day headline, so this tile has to carry it.
    expect(html).toContain("+108/day all regions");
  });

  it("shows the guide-to-follow yield without claiming causation", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={wow}
        stock={stock}
        avgPerDay7={108}
        stats={stats}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("22.3%");
    expect(html).toContain("25 of 112");
    expect(html).toContain("followed after");
    expect(html).not.toContain("because");
  });

  it("degrades each tile independently when its feed is missing", () => {
    const html = renderToStaticMarkup(
      <FollowerKpiRow
        weekOverWeek={null}
        stock={null}
        avgPerDay7={null}
        stats={undefined}
        isFlowLoading={false}
        isStatsLoading={false}
      />,
    );
    expect(html).toContain("Needs two days of follower geography");
    expect(html).toContain("—");
  });
});
