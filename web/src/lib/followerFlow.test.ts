import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock } from "./types";
import {
  chartGeometry,
  describeStockVsFlow,
  formatSignedCount,
  ratePerDay,
  summarizeFollowerFlow,
} from "./followerFlow";
import { describeFreshness } from "./homeDashboard";

let dayCounter = 0;
function point(overrides: Partial<FollowerDailyAddsPoint> = {}): FollowerDailyAddsPoint {
  dayCounter += 1;
  const day = `2026-07-${String(dayCounter).padStart(2, "0")}`;
  const total =
    overrides.total !== undefined
      ? overrides.total
      : (overrides.us ?? 10) + (overrides.southAsian ?? 0) + (overrides.anglosphere ?? 0) + (overrides.other ?? 0);
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: 10,
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

function nullPoint(basis: FollowerDailyAddsPoint["basis"]): FollowerDailyAddsPoint {
  return point({
    us: null,
    southAsian: null,
    anglosphere: null,
    other: null,
    total: null,
    unattributed: null,
    reportedTotalDelta: null,
    spanDays: null,
    stale: basis === "stale" || basis === "pending",
    basis,
  });
}

function series(...points: FollowerDailyAddsPoint[]): FollowerDailyAddsPoint[] {
  return points;
}

describe("ratePerDay", () => {
  it("divides a stale-day catch-up by days covered: 84/day, not 168/day", () => {
    dayCounter = 0;
    const pts = series(
      nullPoint("no_prior_day"),
      nullPoint("stale"),
      point({ us: 168, total: 168, spanDays: 2, basis: "multi_day_span" }),
    );
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: true })).toBe(84);
  });

  it("excludes null points rather than reading them as 0", () => {
    dayCounter = 0;
    const pts = series(nullPoint("no_prior_day"), point({ us: 50, total: 50 }));
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: true })).toBe(50);
  });

  it("excludes provisional points when asked", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 40, total: 40 }),
      point({ us: 100, total: 100, provisional: true }),
    );
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: false })).toBe(40);
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: true })).toBe(70);
  });

  it("returns null (not 0 or NaN) for an all-stale window", () => {
    dayCounter = 0;
    const pts = series(nullPoint("no_prior_day"), nullPoint("stale"), nullPoint("pending"));
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: true })).toBeNull();
  });

  it("goes negative when unfollows dominate", () => {
    dayCounter = 0;
    const pts = series(point({ us: -5, total: -5 }), point({ us: -3, total: -3 }));
    expect(ratePerDay(pts, { windowDays: 7, includeProvisional: true })).toBe(-4);
  });
});

describe("summarizeFollowerFlow", () => {
  it("returns null with fewer than 2 measured days", () => {
    dayCounter = 0;
    expect(summarizeFollowerFlow(series(nullPoint("no_prior_day"), point()))).toBeNull();
  });

  it("ranks bestDay by per-day rate so a span bar can't beat a bigger single day", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 100, total: 100 }),
      point({ us: 168, total: 168, spanDays: 2, basis: "multi_day_span" }),
    );
    const summary = summarizeFollowerFlow(pts)!;
    expect(summary.bestDay).toMatchObject({ total: 100, spanDays: 1, perDay: 100 });
  });

  it("counts stale and pending days and sums the 7-day region window", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 30, southAsian: 5, anglosphere: 10, other: 5 }),
      nullPoint("stale"),
      point({ us: 50, southAsian: 5, anglosphere: 20, other: 5, spanDays: 2, basis: "multi_day_span" }),
      nullPoint("pending"),
    );
    const summary = summarizeFollowerFlow(pts)!;
    expect(summary.staleDays).toBe(2);
    expect(summary.measuredDays).toBe(2);
    expect(summary.window7.us).toBe(80);
    expect(summary.window7.usSharePct).toBe(62); // 80 of 130
  });

  it("keeps the headline rate on the same 7-day basis as the region legend", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 100, total: 100 }),
      point({ us: 91, total: 91 }),
      point({ us: 251, total: 251 }),
      point({ us: 50, total: 50 }),
      point({ us: 50, total: 50 }),
      point({ us: 48, total: 48, provisional: true }),
      point({ us: 47, total: 47, provisional: true }),
    );
    const summary = summarizeFollowerFlow(pts)!;

    // 637 adds over 7 covered days = 91/day. Dropping the two provisional days
    // leaves 542/5 = 108 — a headline the legend printed beside it never agrees
    // with, so the panel contradicts itself on screen.
    expect(summary.window7.total).toBe(637);
    expect(summary.window7.coveredDays).toBe(7);
    expect(summary.window7.provisionalDays).toBe(2); // disclosed, not dropped
    expect(summary.avgPerDay7).toBe(91);
    expect(summary.avgPerDay7!).toBeCloseTo(
      summary.window7.total / summary.window7.coveredDays,
      1,
    );
  });

  it("does not flatter the trend by dropping the newest days from the short window", () => {
    dayCounter = 0;
    // 26 settled days at +100, then two provisional days that collapsed to +10.
    const pts = series(
      ...Array.from({ length: 26 }, () => point({ us: 100, total: 100 })),
      point({ us: 10, total: 10, provisional: true }),
      point({ us: 10, total: 10, provisional: true }),
    );
    const summary = summarizeFollowerFlow(pts)!;

    // Truth: 520/7 = 74.3 against 2620/28 = 93.6 — slowing. Excluding
    // provisional days strips 2 of 7 days from the short window but only 2 of 28
    // from the baseline, so both read 100 and the badge claims "Holding steady".
    expect(summary.avgPerDay7).toBe(74.3);
    expect(summary.avgPerDay28).toBe(93.6);
    expect(summary.trend).toBe("slowing");
  });

  it("accumulates unattributed rank-churn across the window, apart from the regions", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 30, total: 30, unattributed: 4 }),
      point({ us: 50, total: 50, unattributed: -1, spanDays: 1 }),
    );
    const summary = summarizeFollowerFlow(pts)!;
    expect(summary.window7.unattributed).toBe(3); // 4 + (−1), never folded into a region
    expect(summary.window7.us).toBe(80);
    expect(summary.window7.total).toBe(80); // regions only; unattributed stays out
  });
});

describe("formatSignedCount", () => {
  it("signs with the U+2212 minus and leaves zero unsigned", () => {
    expect(formatSignedCount(49)).toBe("+49");
    expect(formatSignedCount(-12)).toBe("−12");
    expect(formatSignedCount(0)).toBe("0");
  });
});

describe("describeStockVsFlow", () => {
  const stock: FollowerStock = {
    capturedAt: "2026-07-25T23:24:27.681Z",
    totalCounted: 4308,
    us: 1489,
    southAsian: 1278,
    anglosphere: 817,
    other: 724,
    countriesReported: 45,
  };

  it("projects days to the next thousand", () => {
    const s = describeStockVsFlow(stock, 91);
    expect(s.nextMilestone).toBe(5000);
    expect(s.daysToNextMilestone).toBe(8); // ceil(692 / 91)
    expect(s.sentence).toContain("5,000");
  });

  it("never returns Infinity or a negative ETA", () => {
    expect(describeStockVsFlow(stock, 0).daysToNextMilestone).toBeNull();
    expect(describeStockVsFlow(stock, -14).daysToNextMilestone).toBeNull();
    expect(describeStockVsFlow(stock, null).daysToNextMilestone).toBeNull();
  });
});

describe("chartGeometry", () => {
  it("always includes zero in the y-domain", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 50, total: 50 }), point({ us: 80, total: 80 })));
    expect(geo.yMin).toBeLessThanOrEqual(0);
    expect(geo.yMax).toBeGreaterThanOrEqual(0);
  });

  it("puts negative segments below the zero line", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 30, total: 30 }), point({ us: -10, total: -10 })));
    const negative = geo.bars[1]!.segments[0]!;
    expect(negative.y).toBe(geo.zeroY);
    expect(negative.height).toBeGreaterThan(0);
  });

  it("stacks a mixed-sign day both ways from zero without overlap", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 30, other: -6, total: 24 })));
    const bar = geo.bars[0]!;
    const up = bar.segments.find((s) => s.region === "us")!;
    const down = bar.segments.find((s) => s.region === "other")!;
    expect(up.y + up.height).toBeCloseTo(geo.zeroY, 0);
    expect(down.y).toBe(geo.zeroY);
  });

  it("makes a spanDays-2 bar occupy two slots", () => {
    dayCounter = 0;
    const geo = chartGeometry(
      series(
        point({ us: 20, total: 20 }),
        nullPoint("stale"),
        point({ us: 168, total: 168, spanDays: 2, basis: "multi_day_span" }),
      ),
    );
    const single = geo.bars[0]!;
    const span = geo.bars.find((b) => b.slots === 2)!;
    expect(span.width).toBeGreaterThan(single.width * 1.8);
    expect(geo.bars.some((b) => b.day === span.day && b.ghost)).toBe(false);
  });

  it("skips stale days entirely but ghosts pending and gap days", () => {
    dayCounter = 0;
    const geo = chartGeometry(
      series(
        nullPoint("no_prior_day"),
        point({ us: 20, total: 20 }),
        nullPoint("stale"),
        nullPoint("pending"),
      ),
    );
    expect(geo.bars.map((b) => b.basis)).toEqual(["no_prior_day", "diff", "pending"]);
    expect(geo.bars.filter((b) => b.ghost)).toHaveLength(2);
  });

  it("survives an all-zero series without dividing by zero", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 0, total: 0 }), point({ us: 0, total: 0 })));
    expect(Number.isFinite(geo.zeroY)).toBe(true);
    expect(geo.meanLine.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it("carries unattributed onto measured bars and leaves ghost bars null", () => {
    dayCounter = 0;
    const geo = chartGeometry(
      series(nullPoint("no_prior_day"), point({ us: 20, total: 20, unattributed: 6 })),
    );
    const measuredBar = geo.bars.find((b) => !b.ghost)!;
    const ghostBar = geo.bars.find((b) => b.ghost)!;
    expect(measuredBar.unattributed).toBe(6);
    expect(ghostBar.unattributed).toBeNull();
  });

  it("spreads a span total evenly into the rolling mean", () => {
    dayCounter = 0;
    const pts = series(
      point({ us: 80, total: 80 }),
      nullPoint("stale"),
      point({ us: 168, total: 168, spanDays: 2, basis: "multi_day_span" }),
    );
    const geo = chartGeometry(pts);
    // Rates: [80, 84, 84] -> trailing means [_, 82, 82.7]
    expect(geo.meanLine[geo.meanLine.length - 1]!.value).toBeCloseTo(82.7, 1);
  });
});

describe("describeFreshness", () => {
  it("labels a stale feed with its age", () => {
    const f = describeFreshness("2026-07-19T12:00:00.000Z", "2026-07-25T18:00:00.000Z")!;
    expect(f.daysOld).toBe(6);
    expect(f.isStale).toBe(true);
    expect(f.label).toContain("6 days old");
  });

  it("treats the threshold boundary as stale and fresher as not", () => {
    expect(describeFreshness("2026-07-22T12:00:00.000Z", "2026-07-25T12:00:00.000Z")!.isStale).toBe(true);
    expect(describeFreshness("2026-07-23T00:00:00.000Z", "2026-07-25T12:00:00.000Z")!.isStale).toBe(false);
  });

  it("returns null for unparseable dates", () => {
    expect(describeFreshness("not-a-date", "2026-07-25T12:00:00.000Z")).toBeNull();
  });
});
