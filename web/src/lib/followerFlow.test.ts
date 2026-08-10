import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock } from "./types";
import {
  axisTicks,
  chartGeometry,
  describeStockVsFlow,
  formatSignedCount,
  ratePerDay,
  summarizeFollowerFlow,
  summarizeFollowerFlowForRange,
  summarizeUsWeekOverWeek,
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

describe("summarizeFollowerFlowForRange", () => {
  it("sums the WHOLE range, not a trailing 7 days", () => {
    const range = series(...Array.from({ length: 10 }, () => point({ us: 10 })));
    const summary = summarizeFollowerFlowForRange(range, [], 0)!;
    expect(summary.windowSums.us).toBe(100); // all 10 days, not 70
    expect(summary.windowSums.coveredDays).toBe(10);
  });

  it("compares against the preceding range and reads accelerating", () => {
    const prior = series(...Array.from({ length: 7 }, () => point({ us: 10 })));
    const range = series(...Array.from({ length: 7 }, () => point({ us: 40 })));
    const summary = summarizeFollowerFlowForRange(range, prior, 7)!;
    expect(summary.trend).toBe("accelerating");
    expect(summary.trendComparable).toBe(true);
  });

  it("reads slowing when the range is well below its predecessor", () => {
    const prior = series(...Array.from({ length: 7 }, () => point({ us: 40 })));
    const range = series(...Array.from({ length: 7 }, () => point({ us: 5 })));
    expect(summarizeFollowerFlowForRange(range, prior, 7)!.trend).toBe("slowing");
  });

  it("withholds the comparison when the predecessor is only partly covered", () => {
    // The real case: a 30-day range on a 41-day account leaves 11 prior days.
    const prior = series(...Array.from({ length: 3 }, () => point({ us: 10 })));
    const range = series(...Array.from({ length: 7 }, () => point({ us: 40 })));
    const summary = summarizeFollowerFlowForRange(range, prior, 7)!;
    expect(summary.trendComparable).toBe(false);
    expect(summary.avgPerDay28).toBeNull();
  });

  it("withholds the comparison when there is no predecessor at all", () => {
    const range = series(...Array.from({ length: 7 }, () => point({ us: 10 })));
    expect(summarizeFollowerFlowForRange(range, [], 7)!.trendComparable).toBe(false);
  });

  it("divides by covered days, so a span-2 catch-up is not double-counted", () => {
    const range = series(
      point({ us: 10 }),
      point({ us: 100, total: 100, spanDays: 2, basis: "multi_day_span" }),
    );
    const summary = summarizeFollowerFlowForRange(range, [], 0)!;
    expect(summary.windowSums.coveredDays).toBe(3); // 1 + 2
    expect(summary.avgPerDay7).toBeCloseTo(110 / 3, 1);
  });

  it("returns null with fewer than 2 measured days", () => {
    expect(summarizeFollowerFlowForRange(series(point()), [], 0)).toBeNull();
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
    expect(summary.windowSums.us).toBe(80);
    expect(summary.windowSums.usSharePct).toBe(62); // 80 of 130
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
    expect(summary.windowSums.total).toBe(637);
    expect(summary.windowSums.coveredDays).toBe(7);
    expect(summary.windowSums.provisionalDays).toBe(2); // disclosed, not dropped
    expect(summary.avgPerDay7).toBe(91);
    expect(summary.avgPerDay7!).toBeCloseTo(
      summary.windowSums.total / summary.windowSums.coveredDays,
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
    expect(summary.windowSums.unattributed).toBe(3); // 4 + (−1), never folded into a region
    expect(summary.windowSums.us).toBe(80);
    expect(summary.windowSums.total).toBe(80); // regions only; unattributed stays out
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
    followersTotal: 4577,
    us: 1489,
    southAsian: 1278,
    anglosphere: 817,
    other: 724,
    countriesReported: 45,
  };

  it("projects days to the next thousand", () => {
    const s = describeStockVsFlow(stock, 91);
    expect(s.nextMilestone).toBe(5000);
    expect(s.daysToNextMilestone).toBe(5); // ceil((5000 − 4577) / 91)
    expect(s.sentence).toContain("5,000");
  });

  it("projects the milestone from the true total, not the 45-country subtotal", () => {
    // 4577 -> 5000 is 423 away; at 91/day that's 5 days. From the 4308 subtotal
    // it would read 8 — a milestone contradicting the headline above it.
    const s = describeStockVsFlow({ ...stock, totalCounted: 4308, followersTotal: 4577 }, 91);
    expect(s.nextMilestone).toBe(5000);
    expect(s.daysToNextMilestone).toBe(5);
    expect(s.stockLabel).toBe("4,577");
  });

  it("falls back to the reported subtotal when the true total is unavailable", () => {
    const s = describeStockVsFlow({ ...stock, totalCounted: 4308, followersTotal: null }, 91);
    expect(s.stockLabel).toBe("4,308");
    expect(s.daysToNextMilestone).toBe(8); // ceil(692/91)
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
    const up = bar.segments.find((s) => s.key === "us")!;
    const down = bar.segments.find((s) => s.key === "other")!;
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

describe("summarizeUsWeekOverWeek", () => {
  it("compares real US counts across two 7-day windows", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 7 }, () => point({ us: 20, total: 20 })), // last week: 140
      ...Array.from({ length: 7 }, () => point({ us: 26, total: 26 })), // this week: 182
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(182);
    expect(s.lastWeek).toBe(140);
    expect(s.deltaCount).toBe(42);
    expect(s.coveredDays).toBe(7);
  });

  it("counts still-settling days and reports how many there are", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 7 }, () => point({ us: 20, total: 20 })),
      ...Array.from({ length: 5 }, () => point({ us: 30, total: 30 })),
      point({ us: 8, total: 8, provisional: true }),
      point({ us: 7, total: 7, provisional: true }),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    // 150 + 8 + 7 = 165 — the provisional days count, matching the chart legend.
    expect(s.thisWeek).toBe(165);
    expect(s.provisionalDays).toBe(2);
  });

  it("withholds the comparison when the prior window is short", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 3 }, () => point({ us: 20, total: 20 })),
      ...Array.from({ length: 7 }, () => point({ us: 30, total: 30 })),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(210);
    expect(s.lastWeek).toBeNull();
    expect(s.deltaCount).toBeNull();
    expect(s.trend).toBe("steady");
  });

  it("reads a 15%-or-greater rise as accelerating and a fall as slowing", () => {
    dayCounter = 0;
    const rising = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 116, total: 116 })),
    );
    // band = max(700 × 0.15, 1) = 105; 812 − 700 = 112 ≥ 105.
    expect(summarizeUsWeekOverWeek(rising)!.trend).toBe("accelerating");

    dayCounter = 0;
    const falling = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 80, total: 80 })),
    );
    // 560 − 700 = −140 ≤ −105.
    expect(summarizeUsWeekOverWeek(falling)!.trend).toBe("slowing");

    dayCounter = 0;
    const flat = series(
      ...Array.from({ length: 7 }, () => point({ us: 100, total: 100 })),
      ...Array.from({ length: 7 }, () => point({ us: 105, total: 105 })),
    );
    // 735 − 700 = 35 < 105.
    expect(summarizeUsWeekOverWeek(flat)!.trend).toBe("steady");
  });

  it("handles a net-negative US week without flipping the trend sign", () => {
    dayCounter = 0;
    const pts = series(
      ...Array.from({ length: 7 }, () => point({ us: 10, total: 10 })),
      ...Array.from({ length: 7 }, () => point({ us: -5, total: -5 })),
    );
    const s = summarizeUsWeekOverWeek(pts)!;
    expect(s.thisWeek).toBe(-35);
    expect(s.lastWeek).toBe(70);
    expect(s.deltaCount).toBe(-105);
    expect(s.trend).toBe("slowing");
  });

  it("returns null when no day in the window is measured", () => {
    dayCounter = 0;
    expect(
      summarizeUsWeekOverWeek(series(nullPoint("no_prior_day"), nullPoint("stale"))),
    ).toBeNull();
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

describe("axisTicks", () => {
  it("picks round steps and always includes zero", () => {
    const ticks = axisTicks(0, 180, 220);
    expect(ticks.map((t) => t.value)).toContain(0);
    // Nice steps only — no 37s or 43s.
    for (const t of ticks) expect(t.value % 50).toBe(0);
    expect(Math.max(...ticks.map((t) => t.value))).toBeGreaterThanOrEqual(180);
  });

  it("spans negative domains without losing the zero line", () => {
    const ticks = axisTicks(-40, 120, 220);
    const values = ticks.map((t) => t.value);
    expect(values).toContain(0);
    expect(Math.min(...values)).toBeLessThanOrEqual(-40);
  });

  it("maps values to descending y pixels inside the plot", () => {
    const ticks = axisTicks(0, 100, 220);
    const zero = ticks.find((t) => t.value === 0)!;
    const top = ticks.reduce((a, b) => (b.value > a.value ? b : a));
    expect(zero.y).toBeGreaterThan(top.y); // y grows downward
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(zero.y).toBeLessThanOrEqual(220);
  });

  it("keeps every tick inside the plot band across many domains", () => {
    // The bug this guards: rounding the tick range outward while the bars kept
    // the raw range pushed the top tick above the chart, where it clipped.
    const domains: Array<[number, number]> = [
      [0, 180], [0, 100], [-40, 120], [0, 0],
      [0, 7], [-5, 3], [0, 1234], [-200, -10],
    ];
    for (const [lo, hi] of domains) {
      for (const t of axisTicks(lo, hi, 220)) {
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(220);
      }
    }
  });

  it("aligns bar tops with the gridline of the same value", () => {
    dayCounter = 0;
    // A single +150 bar against ticks stepping by 50: its top must land exactly
    // on the 150 gridline, not near it.
    const geo = chartGeometry(
      series(point({ us: 150, total: 150 }), point({ us: 50, total: 50 })),
      720,
      220,
      34,
    );
    const tallest = geo.bars.find((b) => b.total === 150)!;
    const barTop = Math.min(...tallest.segments.map((sg) => sg.y));
    const tick150 = geo.ticks.find((t) => t.value === 150);
    expect(tick150).toBeDefined();
    expect(barTop).toBeCloseTo(tick150!.y, 1);
  });

  it("returns a usable single tick for a flat all-zero series", () => {
    const ticks = axisTicks(0, 0, 220);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.every((t) => Number.isFinite(t.y))).toBe(true);
  });
});

describe("chartGeometry gutter", () => {
  it("defaults to no gutter so existing coordinates are untouched", () => {
    dayCounter = 0;
    const geo = chartGeometry(series(point({ us: 20, total: 20 }), point({ us: 30, total: 30 })));
    expect(geo.gutterLeft).toBe(0);
    expect(geo.bars[0]!.x).toBeGreaterThanOrEqual(0);
  });

  it("shifts bars right by the gutter and narrows them to fit", () => {
    dayCounter = 0;
    const pts = series(point({ us: 20, total: 20 }), point({ us: 30, total: 30 }));
    const plain = chartGeometry(pts, 720, 220, 0);
    dayCounter = 0;
    const gutter = chartGeometry(pts, 720, 220, 34);

    expect(gutter.gutterLeft).toBe(34);
    expect(gutter.bars[0]!.x).toBeGreaterThan(plain.bars[0]!.x);
    expect(gutter.bars[0]!.width).toBeLessThan(plain.bars[0]!.width);
    // Right edge still inside the viewBox.
    const last = gutter.bars[gutter.bars.length - 1]!;
    expect(last.x + last.width).toBeLessThanOrEqual(720);
  });

  it("supplies ticks spanning the data domain", () => {
    dayCounter = 0;
    const geo = chartGeometry(
      series(point({ us: 40, total: 40 }), point({ us: 160, total: 160 })),
      720,
      220,
      34,
    );
    expect(geo.ticks.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...geo.ticks.map((t) => t.value))).toBeGreaterThanOrEqual(160);
  });
});
