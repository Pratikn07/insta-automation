import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./types";
import { slotFromOffset, tooltipModel } from "./chartTooltip";

function point(overrides: Partial<FollowerDailyAddsPoint> = {}): FollowerDailyAddsPoint {
  const us = overrides.us ?? 0;
  const southAsian = overrides.southAsian ?? 0;
  const anglosphere = overrides.anglosphere ?? 0;
  const other = overrides.other ?? 0;
  const total = overrides.total !== undefined ? overrides.total : us + southAsian + anglosphere + other;
  return {
    day: "2026-07-24",
    capturedAt: "2026-07-24T23:00:00.000Z",
    us,
    southAsian,
    anglosphere,
    other,
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

describe("tooltipModel", () => {
  it("lists the day, total, and each non-zero region", () => {
    const m = tooltipModel(point({ us: 41, southAsian: 6, anglosphere: 13, other: -1 }));
    expect(m.heading).toBe("Jul 24");
    expect(m.totalLabel).toBe("+59 net");
    expect(m.rows.map((r) => r.region)).toEqual(["us", "southAsian", "anglosphere", "other"]);
    expect(m.rows.map((r) => r.valueLabel)).toEqual(["+41", "+6", "+13", "−1"]);
    expect(m.notes).toEqual([]);
    expect(m.emptyLabel).toBeNull();
  });

  it("omits zero-value regions rather than printing a row of zeros", () => {
    const m = tooltipModel(point({ us: 20, southAsian: 0, anglosphere: 4, other: 0 }));
    expect(m.rows.map((r) => r.region)).toEqual(["us", "anglosphere"]);
  });

  it("says so when a measured day nets to nothing across every region", () => {
    const m = tooltipModel(point({ us: 0, southAsian: 0, anglosphere: 0, other: 0, total: 0 }));
    expect(m.rows).toEqual([]);
    expect(m.emptyLabel).toBe("No net change");
    expect(m.totalLabel).toBe("0 net");
  });

  it("spans the date range and explains a combined multi-day bar", () => {
    const m = tooltipModel(point({ day: "2026-07-21", us: 96, spanDays: 2, basis: "multi_day_span" }));
    expect(m.heading).toBe("Jul 20–21");
    expect(m.notes).toContain("Meta did not refresh in between");
  });

  it("repeats the month only when a span crosses one", () => {
    const m = tooltipModel(point({ day: "2026-08-01", us: 40, spanDays: 2, basis: "multi_day_span" }));
    expect(m.heading).toBe("Jul 31–Aug 1");
  });

  it("discloses a still-settling day", () => {
    const m = tooltipModel(point({ us: 30, provisional: true }));
    expect(m.notes).toContain("Still settling — Meta may revise");
  });

  it("reports unplaced rank-churn when non-zero", () => {
    const m = tooltipModel(point({ us: 30, unattributed: 3 }));
    expect(m.notes).toContain("+3 unplaced (top-country cutoff)");
  });

  it("omits the unplaced note when it is zero", () => {
    expect(tooltipModel(point({ us: 30, unattributed: 0 })).notes).toEqual([]);
  });

  it("explains each kind of gap column instead of showing empty rows", () => {
    const gap = (basis: FollowerDailyAddsPoint["basis"], note: string) => {
      const m = tooltipModel(
        point({
          basis,
          total: null,
          spanDays: null,
          us: null,
          southAsian: null,
          anglosphere: null,
          other: null,
        }),
      );
      expect(m.totalLabel).toBeNull();
      expect(m.rows).toEqual([]);
      expect(m.notes).toContain(note);
    };
    gap("pending", "Waiting for Meta to refresh");
    gap("no_snapshot", "No snapshot captured");
    gap("no_prior_day", "Series start — nothing to diff against");
    gap("stale", "Absorbed into the next bar");
  });
});

describe("slotFromOffset", () => {
  // Chart is 720 viewBox units wide with a 34-unit gutter, rendered at 1080px
  // (1.5× scale), 20 slots. Plot spans SVG x 42..712, so each slot is 33.5 units.
  const args = { containerWidth: 1080, viewBoxWidth: 720, gutterLeft: 34, slotCount: 20 };
  const slot = (offsetX: number) =>
    slotFromOffset(offsetX, args.containerWidth, args.viewBoxWidth, args.gutterLeft, args.slotCount);

  it("converts screen pixels to svg units before picking a slot", () => {
    // 1.5× scale: screen 63px -> svg 42 = the very start of slot 0.
    expect(slot(63)).toBe(0);
    // Middle of the plot lands mid-series, not at the end.
    expect(slot(1080 / 2)).toBe(9);
  });

  it("returns the last slot at the right edge and never overflows", () => {
    expect(slot(1079)).toBe(19);
    expect(slot(5000)).toBe(19);
  });

  it("returns null left of the plot area so the y-axis labels are not hoverable", () => {
    expect(slot(0)).toBeNull();
    expect(slot(10)).toBeNull();
  });

  it("clamps a negative offset to null rather than a negative index", () => {
    expect(slot(-40)).toBeNull();
  });

  it("degrades safely when the container has not been measured yet", () => {
    expect(slotFromOffset(50, 0, 720, 34, 20)).toBeNull();
    expect(slotFromOffset(50, 1080, 720, 34, 0)).toBeNull();
  });
});
