import { describe, expect, it } from "vitest";
import {
  asCounts,
  buildDailyPoints,
  diffAnchors,
  stockFrom,
  type AnchorSnapshot,
} from "./followerFlowCore.js";

function anchor(day: string, counts: Record<string, number>): AnchorSnapshot {
  return {
    day,
    capturedAt: new Date(`${day}T23:00:00.000Z`),
    counts,
    totalCounted: Object.values(counts).reduce((s, v) => s + v, 0),
  };
}

describe("asCounts", () => {
  it("passes through finite numeric entries and drops everything else", () => {
    expect(asCounts({ US: 10, IN: 5, junk: "x", inf: Infinity, nan: NaN })).toEqual({
      US: 10,
      IN: 5,
    });
  });

  it("returns empty for null, arrays, and non-objects", () => {
    expect(asCounts(null)).toEqual({});
    expect(asCounts([1, 2])).toEqual({});
    expect(asCounts("US")).toEqual({});
  });
});

describe("diffAnchors", () => {
  it("buckets shared-key deltas by region and preserves negatives", () => {
    const prev = anchor("2026-07-01", { US: 100, IN: 50, GB: 20, DE: 10, AE: 5 });
    const cur = anchor("2026-07-02", { US: 112, IN: 55, GB: 24, DE: 10, AE: 4 });
    const d = diffAnchors(prev, cur);
    expect(d.us).toBe(12);
    expect(d.southAsian).toBe(5);
    expect(d.anglosphere).toBe(4);
    expect(d.other).toBe(-1); // AE unfollow passes through
    expect(d.total).toBe(20);
    expect(d.unattributed).toBe(0);
  });

  it("never reads a missing country as zero — churn goes to unattributed", () => {
    // LK (4) fell out of Meta's reported set; PK (9) entered. Neither is a
    // real +9/-4 of follows; both net into unattributed.
    const prev = anchor("2026-07-01", { US: 10, LK: 4 });
    const cur = anchor("2026-07-02", { US: 12, PK: 9 });
    const d = diffAnchors(prev, cur);
    expect(d.us).toBe(2);
    expect(d.southAsian).toBe(0);
    expect(d.total).toBe(2);
    expect(d.unattributed).toBe(5); // entered 9 - exited 4
  });

  it("satisfies reportedTotalDelta === total + unattributed", () => {
    const prev = anchor("2026-07-01", { US: 100, IN: 50, LK: 4 });
    const cur = anchor("2026-07-02", { US: 110, IN: 52, PK: 7 });
    const d = diffAnchors(prev, cur);
    expect(d.reportedTotalDelta).toBe(d.total + d.unattributed);
  });

  it("records a per-country delta for every shared key, signs preserved", () => {
    const prev = anchor("2026-07-01", { US: 100, IN: 50, GB: 20, ZA: 30, AE: 5 });
    const cur = anchor("2026-07-02", { US: 112, IN: 55, GB: 24, ZA: 36, AE: 4 });
    const d = diffAnchors(prev, cur);
    expect(d.byCountry).toEqual({ US: 12, IN: 5, GB: 4, ZA: 6, AE: -1 });
  });

  it("omits a country that entered or left the reported set — never zero-filled", () => {
    // The real failure this guards: HK and BR each entered Meta's top-45 on 3
    // separate days in the 14 to 2026-08-09. Diffing an absent prior as 0 would
    // render each country's entire cumulative count as one day's gain.
    const prev = anchor("2026-07-01", { US: 10, LK: 4 });
    const cur = anchor("2026-07-02", { US: 12, HK: 9 });
    const d = diffAnchors(prev, cur);
    expect(d.byCountry).toEqual({ US: 2 });
    expect(d.byCountry.HK).toBeUndefined(); // entered — unknown, not +9
    expect(d.byCountry.LK).toBeUndefined(); // exited — unknown, not -4
    expect(d.unattributed).toBe(5);
  });

  it("keeps byCountry reconciled: sum + unattributed === reportedTotalDelta", () => {
    const prev = anchor("2026-07-01", { US: 100, IN: 50, ZA: 30, LK: 4 });
    const cur = anchor("2026-07-02", { US: 110, IN: 52, ZA: 37, BR: 7 });
    const d = diffAnchors(prev, cur);
    const summed = Object.values(d.byCountry).reduce((s, v) => s + v, 0);
    expect(summed).toBe(d.total);
    expect(summed + d.unattributed).toBe(d.reportedTotalDelta);
  });
});

describe("buildDailyPoints", () => {
  it("emits no_prior_day for the first day", () => {
    const pts = buildDailyPoints([anchor("2026-07-01", { US: 100 })]);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ basis: "no_prior_day", total: null, spanDays: null });
  });

  it("absorbs a full stale analytics day into the next real diff as a 2-day span", () => {
    // Jul 21 byte-identical to Jul 20; Jul 22 carries both days' adds.
    const pts = buildDailyPoints([
      anchor("2026-07-19", { US: 1000 }),
      anchor("2026-07-20", { US: 1100 }),
      anchor("2026-07-21", { US: 1100 }),
      anchor("2026-07-22", { US: 1268 }),
    ]);
    expect(pts.map((p) => p.basis)).toEqual(["no_prior_day", "diff", "stale", "multi_day_span"]);
    expect(pts[2]).toMatchObject({ total: null, stale: true, spanDays: null });
    expect(pts[3]).toMatchObject({ total: 168, spanDays: 2 });
  });

  it("treats a missing-snapshot day the same way: null point, next diff spans it", () => {
    const pts = buildDailyPoints([
      anchor("2026-07-01", { US: 100 }),
      anchor("2026-07-03", { US: 130 }),
    ]);
    expect(pts.map((p) => p.basis)).toEqual(["no_prior_day", "no_snapshot", "multi_day_span"]);
    expect(pts[1]!.capturedAt).toBeNull();
    expect(pts[2]).toMatchObject({ total: 30, spanDays: 2 });
  });

  it("distinguishes a measured net-zero day from a stale day", () => {
    // US +1 / IN -1 is a real refresh with zero net — not byte-identical.
    const pts = buildDailyPoints([
      anchor("2026-07-01", { US: 100, IN: 50 }),
      anchor("2026-07-02", { US: 101, IN: 49 }),
    ]);
    expect(pts[1]).toMatchObject({ basis: "diff", total: 0, stale: false });
  });

  it("marks trailing stale days pending, not stale", () => {
    const pts = buildDailyPoints([
      anchor("2026-07-01", { US: 100 }),
      anchor("2026-07-02", { US: 110 }),
      anchor("2026-07-03", { US: 110 }),
      anchor("2026-07-04", { US: 110 }),
    ]);
    expect(pts.map((p) => p.basis)).toEqual(["no_prior_day", "diff", "pending", "pending"]);
  });

  it("flags the newest measured days provisional", () => {
    const pts = buildDailyPoints([
      anchor("2026-07-01", { US: 100 }),
      anchor("2026-07-02", { US: 110 }),
      anchor("2026-07-03", { US: 120 }),
      anchor("2026-07-04", { US: 130 }),
    ]);
    expect(pts.map((p) => p.provisional)).toEqual([false, false, true, true]);
  });

  it("returns empty for no anchors", () => {
    expect(buildDailyPoints([])).toEqual([]);
  });

  it("carries byCountry on measured points and null on gap days", () => {
    const pts = buildDailyPoints([
      anchor("2026-07-01", { US: 100, ZA: 20 }),
      anchor("2026-07-02", { US: 110, ZA: 26 }),
    ]);
    expect(pts[0]!.byCountry).toBeNull(); // no_prior_day
    expect(pts[1]!.byCountry).toEqual({ US: 10, ZA: 6 });
  });

  it("gives a multi-day-span point the country deltas covering its whole span", () => {
    // Jul 21 byte-identical to Jul 20, so Jul 22 carries both days per country.
    const pts = buildDailyPoints([
      anchor("2026-07-19", { US: 1000, ZA: 100 }),
      anchor("2026-07-20", { US: 1100, ZA: 110 }),
      anchor("2026-07-21", { US: 1100, ZA: 110 }),
      anchor("2026-07-22", { US: 1268, ZA: 125 }),
    ]);
    expect(pts[2]!.byCountry).toBeNull(); // stale — its adds live in the next bar
    expect(pts[3]).toMatchObject({ spanDays: 2, byCountry: { US: 168, ZA: 15 } });
  });
});

describe("stockFrom followersTotal", () => {
  const snapshot: AnchorSnapshot = {
    day: "2026-07-26",
    capturedAt: new Date("2026-07-26T18:07:52.909Z"),
    counts: { US: 1522, IN: 1278, GB: 400, BR: 100 },
    totalCounted: 3300,
  };

  it("carries the true total alongside the 45-country subtotal", () => {
    const stock = stockFrom(snapshot, 4578);
    expect(stock.followersTotal).toBe(4578);
    // The demographics subtotal is preserved, not overwritten — the regional
    // diff math is built on it.
    expect(stock.totalCounted).toBe(3300);
  });

  it("leaves followersTotal null when the profile fetch failed", () => {
    expect(stockFrom(snapshot, null).followersTotal).toBeNull();
  });

  it("defaults followersTotal to null when the argument is omitted", () => {
    expect(stockFrom(snapshot).followersTotal).toBeNull();
  });
});
