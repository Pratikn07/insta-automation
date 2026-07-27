import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./types";
import { hitTestDay, shownSpikeDays, tooltipModel } from "./chartTooltip";

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

  it("flags a spike day and points at the candidate list below", () => {
    const m = tooltipModel(
      point({
        us: 180,
        spike: {
          multiple: 4.4,
          net: 187,
          baselineMedian: 42.5,
          confidence: "medium",
          candidates: [
            {
              mediaId: "a",
              caption: "I made this from an egg carton",
              thumbnailUrl: null,
              permalink: null,
              postedAt: "2026-07-08T23:28:53.000Z",
              reachGained: 7885,
              sharePct: 49,
            },
          ],
        },
      }),
      ["2026-07-24"],
    );
    expect(m.notes).toContain("4.4× your usual day — candidates below");
  });

  it("still flags a spike the panel left out, but promises no candidates", () => {
    // The panel shows only the two newest spikes. Older spike days must not
    // advertise a card that is not on the page — browser-verified regression.
    const m = tooltipModel(
      point({
        us: 180,
        spike: {
          multiple: 2.7,
          net: 105,
          baselineMedian: 39,
          confidence: "high",
          candidates: [],
        },
      }),
      ["2026-07-26", "2026-07-25"],
    );
    expect(m.notes).toContain("2.7× your usual day");
    expect(m.notes.some((n) => n.includes("candidates below"))).toBe(false);
  });

  it("says nothing about spikes on an ordinary day", () => {
    const m = tooltipModel(point({ us: 40 }));
    expect(m.notes.some((n) => n.includes("usual day"))).toBe(false);
  });

  it("keeps the spike note alongside the other caveats", () => {
    const m = tooltipModel(
      point({
        us: 180,
        provisional: true,
        unattributed: 3,
        spike: {
          multiple: 5.7,
          net: 251,
          baselineMedian: 44,
          confidence: "high",
          candidates: [],
        },
      }),
      ["2026-07-24"],
    );
    expect(m.notes).toContain("5.7× your usual day — candidates below");
    expect(m.notes).toContain("Still settling — Meta may revise");
    expect(m.notes).toContain("+3 unplaced (top-country cutoff)");
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

describe("shownSpikeDays", () => {
  const spike = {
    multiple: 3,
    net: 120,
    baselineMedian: 40,
    confidence: "high" as const,
    candidates: [],
  };

  it("returns the two newest spike days, newest first", () => {
    const days = shownSpikeDays([
      point({ day: "2026-07-11", spike }),
      point({ day: "2026-07-15", spike }),
      point({ day: "2026-07-22", spike }),
      point({ day: "2026-07-23", spike }),
    ]);
    expect(days).toEqual(["2026-07-23", "2026-07-22"]);
  });

  it("ignores days without a spike and returns empty when there are none", () => {
    expect(shownSpikeDays([point({ day: "2026-07-18" }), point({ day: "2026-07-19" })])).toEqual([]);
  });

  it("does not pad when only one spike exists", () => {
    expect(shownSpikeDays([point({ day: "2026-07-04" }), point({ day: "2026-07-23", spike })]))
      .toEqual(["2026-07-23"]);
  });
});


describe("hitTestDay", () => {
  // Mirrors what chartGeometry actually emits for a 13-point series where index 6
  // is stale (no bar) and index 7 is a span-2 bar covering slots 6 AND 7.
  // slotWidth = (712-42)/13 = 51.54, BAR_FILL = 0.72.
  const bars = [
    { day: "2026-07-14", x: 49.2, width: 37.1 },
    { day: "2026-07-15", x: 100.7, width: 37.1 },
    { day: "2026-07-16", x: 152.3, width: 37.1 },
    { day: "2026-07-17", x: 203.8, width: 37.1 },
    { day: "2026-07-18", x: 255.4, width: 37.1 },
    { day: "2026-07-19", x: 306.9, width: 37.1 },
    // No bar for 07-20: it is stale and absorbed by the span bar below.
    { day: "2026-07-21", x: 358.4, width: 88.7 }, // span-2
    { day: "2026-07-22", x: 461.5, width: 37.1 },
    { day: "2026-07-23", x: 513.1, width: 37.1 },
  ];
  const hit = (offsetX: number) => hitTestDay(offsetX, 1050, 720, bars);
  // 1050px container over a 720 viewBox = 1.458× scale.
  const px = (svgX: number) => (svgX / 720) * 1050;

  it("converts screen pixels to svg units before testing", () => {
    // Without the conversion, px(207) would land on a different bar entirely.
    expect(hit(px(207))).toBe("2026-07-17");
    expect(hit(px(104))).toBe("2026-07-15");
  });

  it("resolves the whole width of a span bar to that bar, not the day it absorbed", () => {
    // The regression this replaced: index arithmetic mapped the span bar's left
    // half to the stale day, which draws no bar, so the span tooltip was
    // unreachable. Verified in a browser before the fix.
    expect(hit(px(365))).toBe("2026-07-21"); // left portion
    expect(hit(px(402))).toBe("2026-07-21"); // middle
    expect(hit(px(440))).toBe("2026-07-21"); // right portion
  });

  it("never resolves to a day that has no drawn bar", () => {
    const days = new Set(bars.map((b) => b.day));
    for (let svgX = 42; svgX <= 550; svgX += 3) {
      const day = hit(px(svgX));
      if (day !== null) expect(days.has(day)).toBe(true);
    }
  });

  it("snaps to the nearest bar in the gap between two bars", () => {
    // Gap between the 07-14 and 07-15 bars: 86.3..100.7, midpoint ~93.5.
    expect(hit(px(88))).toBe("2026-07-14");
    expect(hit(px(99))).toBe("2026-07-15");
  });

  it("returns null outside the plot inset on either side", () => {
    expect(hit(px(2))).toBeNull();
    expect(hit(px(719))).toBeNull();
  });

  it("degrades safely with no bars or an unmeasured container", () => {
    expect(hitTestDay(500, 1050, 720, [])).toBeNull();
    expect(hitTestDay(500, 0, 720, bars)).toBeNull();
  });
});
