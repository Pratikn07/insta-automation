import { describe, expect, it } from "vitest";
import {
  allocateDailyPoints,
  apportion,
  exactNetAddsByDay,
  padPointsThrough,
  rescaleToExact,
  type ExactDay,
  type TotalAnchor,
} from "./followerAllocationCore.js";
import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";

function measuredPoint(
  day: string,
  byCountry: Record<string, number>,
  spanDays = 1,
): FollowerDailyAddsPoint {
  const total = Object.values(byCountry).reduce((s, v) => s + v, 0);
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: byCountry.US ?? 0,
    southAsian: byCountry.IN ?? 0,
    anglosphere: byCountry.GB ?? 0,
    other: 0,
    total,
    unattributed: 0,
    byCountry,
    reportedTotalDelta: total,
    spanDays,
    stale: false,
    provisional: false,
    basis: spanDays > 1 ? "multi_day_span" : "diff",
  };
}

function gapPoint(day: string, basis: FollowerDailyAddsPoint["basis"]): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: null,
    us: null,
    southAsian: null,
    anglosphere: null,
    other: null,
    total: null,
    unattributed: null,
    byCountry: null,
    reportedTotalDelta: null,
    spanDays: null,
    stale: basis === "stale" || basis === "pending",
    provisional: false,
    basis,
  };
}

function anchor(day: string, followersTotal: number): TotalAnchor {
  return { day, capturedAt: new Date(`${day}T23:00:00.000Z`), followersTotal };
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);

describe("apportion", () => {
  it("sums exactly to the total, whatever the weights", () => {
    for (const total of [1, 7, 100, 483, 5001]) {
      for (const weights of [[1, 1, 1], [200, 100], [3, 0, 0], [1, 2, 3, 4, 5]]) {
        expect(apportion(total, weights).reduce((s, v) => s + v, 0)).toBe(total);
      }
    }
  });

  it("hands leftover units to the largest remainders rather than rounding each share", () => {
    // Plain rounding gives 0,0,0 here and the follower disappears from the chart.
    expect(apportion(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(apportion(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(apportion(10, [3, 3, 4])).toEqual([3, 3, 4]);
  });

  it("preserves sign for a shrinking country", () => {
    expect(apportion(-9, [2, 1])).toEqual([-6, -3]);
    expect(apportion(-1, [1, 1])).toEqual([-1, -0]);
  });

  it("falls back to an even split when no weight is usable", () => {
    expect(apportion(4, [0, 0, 0, 0])).toEqual([1, 1, 1, 1]);
    expect(apportion(4, [NaN, -3])).toEqual([2, 2]);
  });

  it("returns nothing for an empty day set", () => {
    expect(apportion(50, [])).toEqual([]);
  });
});

describe("exactNetAddsByDay", () => {
  it("diffs consecutive daily anchors", () => {
    const map = exactNetAddsByDay([
      anchor("2026-08-01", 5000),
      anchor("2026-08-02", 5150),
      anchor("2026-08-03", 5210),
    ]);
    expect(map.get("2026-08-02")).toEqual({ netAdds: 150, spanDays: 1 });
    expect(map.get("2026-08-03")).toEqual({ netAdds: 60, spanDays: 1 });
  });

  it("gives the first anchor no point of its own — nothing to diff against", () => {
    const map = exactNetAddsByDay([anchor("2026-08-01", 5000), anchor("2026-08-02", 5150)]);
    expect(map.has("2026-08-01")).toBe(false);
  });

  it("spreads a missed capture across the days it covers instead of spiking one", () => {
    const map = exactNetAddsByDay([anchor("2026-08-01", 5000), anchor("2026-08-04", 5300)]);
    expect(map.get("2026-08-02")).toEqual({ netAdds: 100, spanDays: 3 });
    expect(map.get("2026-08-03")).toEqual({ netAdds: 100, spanDays: 3 });
    expect(map.get("2026-08-04")).toEqual({ netAdds: 100, spanDays: 3 });
  });

  it("carries a genuine loss through as a negative", () => {
    const map = exactNetAddsByDay([anchor("2026-08-01", 5000), anchor("2026-08-02", 4970)]);
    expect(map.get("2026-08-02")!.netAdds).toBe(-30);
  });

  it("tolerates unordered input", () => {
    const map = exactNetAddsByDay([anchor("2026-08-03", 5210), anchor("2026-08-02", 5150)]);
    expect(map.get("2026-08-03")).toEqual({ netAdds: 60, spanDays: 1 });
  });
});

describe("rescaleToExact", () => {
  it("grows the gaining countries up to the exact total", () => {
    const out = rescaleToExact({ US: 40, IN: 27 }, 200)!;
    expect(sum(out)).toBe(200);
    expect(out.US).toBeGreaterThan(out.IN!);
  });

  it("never inflates a country Meta reported as losing followers", () => {
    // The shortfall being closed is unplaced FOLLOWS, so it belongs to gainers.
    // Scaling the whole vector by 200/80 would report -50 for a measured -20.
    const out = rescaleToExact({ US: 100, IN: -20 }, 200)!;
    expect(out.IN).toBe(-20);
    expect(out.US).toBe(220);
    expect(sum(out)).toBe(200);
  });

  it("declines when there is nothing gaining to scale", () => {
    expect(rescaleToExact({ US: -10, IN: -5 }, 40)).toBeNull();
    expect(rescaleToExact({}, 40)).toBeNull();
  });

  it("declines when the gainers cannot reach the target", () => {
    // A day the account shrank: no amount of growth in the gainers produces it.
    expect(rescaleToExact({ US: 10, IN: -5 }, -30)).toBeNull();
  });
});

describe("padPointsThrough", () => {
  it("extends the axis past Meta's ~48h demographics lag", () => {
    const padded = padPointsThrough([measuredPoint("2026-08-01", { US: 10 })], "2026-08-03");
    expect(padded.map((p) => p.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(padded[2]!.basis).toBe("no_snapshot");
    expect(padded[2]!.total).toBeNull();
  });

  it("leaves an already-current axis alone", () => {
    const points = [measuredPoint("2026-08-03", { US: 10 })];
    expect(padPointsThrough(points, "2026-08-03")).toBe(points);
    expect(padPointsThrough(points, "2026-08-01")).toBe(points);
  });

  it("does nothing with no points to extend", () => {
    expect(padPointsThrough([], "2026-08-03")).toEqual([]);
  });
});

describe("allocateDailyPoints", () => {
  const exact = (entries: Array<[string, number]>): Map<string, ExactDay> =>
    new Map(entries.map(([day, netAdds]) => [day, { netAdds, spanDays: 1 }]));

  it("breaks a multi-day catch-up bar into real daily bars", () => {
    // The bug the owner reported: Meta skipped a refresh, so three calendar days
    // collapsed into one wide bar carrying +100 while the account actually grew
    // by 480.
    const points = [
      gapPoint("2026-08-15", "no_prior_day"),
      gapPoint("2026-08-16", "stale"),
      measuredPoint("2026-08-17", { US: 60, IN: 40 }, 2),
    ];
    const out = allocateDailyPoints(
      points,
      exact([
        ["2026-08-16", 300],
        ["2026-08-17", 180],
      ]),
    );

    expect(out.map((p) => p.total)).toEqual([null, 300, 180]);
    expect(out[1]!.basis).toBe("diff");
    expect(out[1]!.stale).toBe(false);
    expect(out[1]!.spanDays).toBe(1);
    expect(out[1]!.estimated).toBe(true);
    expect(out[2]!.estimated).toBe(true);
    // 480 across two days, against the +100 the demographic bar alone reported.
    expect(out[1]!.total! + out[2]!.total!).toBe(480);
    expect(out[2]!.measuredTotal).toBe(100);
  });

  it("weights the apportioning by how much the account actually grew each day", () => {
    const points = [gapPoint("2026-08-16", "stale"), measuredPoint("2026-08-17", { US: 90 }, 2)];
    const out = allocateDailyPoints(
      points,
      exact([
        ["2026-08-16", 300],
        ["2026-08-17", 100],
      ]),
    );
    expect(out[0]!.total).toBe(300);
    expect(out[1]!.total).toBe(100);
  });

  it("keeps every bar summing to its own country split", () => {
    const points = [
      measuredPoint("2026-08-01", { US: 30, IN: 20, GB: 5 }),
      gapPoint("2026-08-02", "stale"),
      measuredPoint("2026-08-03", { US: 40, IN: 30, GB: 10 }, 2),
      gapPoint("2026-08-04", "pending"),
    ];
    const out = allocateDailyPoints(
      points,
      exact([
        ["2026-08-01", 90],
        ["2026-08-02", 120],
        ["2026-08-03", 110],
        ["2026-08-04", 75],
      ]),
    );
    for (const point of out) {
      if (point.byCountry === null) continue;
      expect(sum(point.byCountry)).toBe(point.total);
      expect(point.us! + point.southAsian! + point.anglosphere! + point.other!).toBe(point.total);
    }
  });

  it("fills a day Meta never reported using the most recent measured shape", () => {
    // Today and yesterday, still inside Meta's demographics lag. Without this the
    // owner's most recent growth is simply absent from the chart.
    const points = [
      measuredPoint("2026-08-16", { US: 60, IN: 40 }),
      gapPoint("2026-08-17", "no_snapshot"),
    ];
    const out = allocateDailyPoints(
      points,
      exact([
        ["2026-08-16", 100],
        ["2026-08-17", 200],
      ]),
    );
    expect(out[1]!.total).toBe(200);
    expect(out[1]!.byCountry).not.toBeNull();
    expect(sum(out[1]!.byCountry!)).toBe(200);
    expect(out[1]!.estimated).toBe(true);
    expect(out[1]!.measuredTotal).toBeNull();
    // Shape borrowed from the 60/40 day before it.
    expect(out[1]!.byCountry!.US).toBeGreaterThan(out[1]!.byCountry!.IN!);
  });

  it("reports a total without inventing a geography when no shape exists yet", () => {
    const out = allocateDailyPoints(
      [gapPoint("2026-08-16", "no_snapshot")],
      exact([["2026-08-16", 140]]),
    );
    expect(out[0]!.total).toBe(140);
    expect(out[0]!.byCountry).toBeNull();
    expect(out[0]!.us).toBeNull();
    expect(out[0]!.estimated).toBe(true);
  });

  it("leaves history untouched where no followers_count capture exists", () => {
    const original = measuredPoint("2026-07-01", { US: 30, IN: 20 });
    const out = allocateDailyPoints([original], new Map());
    expect(out[0]!.total).toBe(50);
    expect(out[0]!.byCountry).toEqual({ US: 30, IN: 20 });
    expect(out[0]!.estimated).toBe(false);
    expect(out[0]!.exactTotal).toBeNull();
    expect(out[0]!.basis).toBe("diff");
  });

  it("clears unattributed once the residual has been folded into the countries", () => {
    // Otherwise the panel's "N more Meta counted but couldn't place" line double
    // counts followers the rescale has already attributed.
    const point = { ...measuredPoint("2026-08-16", { US: 60 }), unattributed: 25 };
    const out = allocateDailyPoints([point], exact([["2026-08-16", 120]]));
    expect(out[0]!.total).toBe(120);
    expect(out[0]!.unattributed).toBe(0);
  });

  it("keeps Meta's measurement on a shrinking day rather than forcing a rescale", () => {
    const out = allocateDailyPoints(
      [measuredPoint("2026-08-16", { US: 10, IN: -5 })],
      exact([["2026-08-16", -40]]),
    );
    expect(out[0]!.byCountry).toEqual({ US: 10, IN: -5 });
    expect(out[0]!.exactTotal).toBe(-40);
    expect(out[0]!.estimated).toBe(true);
  });

  it("preserves the day axis exactly", () => {
    const points = [
      measuredPoint("2026-08-01", { US: 10 }),
      gapPoint("2026-08-02", "stale"),
      gapPoint("2026-08-03", "no_snapshot"),
      measuredPoint("2026-08-04", { US: 20 }, 3),
    ];
    const out = allocateDailyPoints(points, exact([["2026-08-02", 50]]));
    expect(out.map((p) => p.day)).toEqual(points.map((p) => p.day));
  });
});
