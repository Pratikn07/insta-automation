import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./types";
import {
  clampRange,
  coverageOf,
  filterPointsToRange,
  precedingRange,
  rangeLengthDays,
  resolvePreset,
  shiftDay,
} from "./dateRange";

function point(day: string, basis: FollowerDailyAddsPoint["basis"] = "diff"): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: 1,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total: 1,
    unattributed: 0,
    byCountry: { US: 1 },
    reportedTotalDelta: 1,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis,
  };
}

const days = (...ds: string[]) => ds.map((d) => point(d));

describe("shiftDay", () => {
  it("moves whole days without local-time drift", () => {
    expect(shiftDay("2026-07-15", 1)).toBe("2026-07-16");
    expect(shiftDay("2026-07-15", -1)).toBe("2026-07-14");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftDay("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDay("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("crosses a US DST boundary without losing a day", () => {
    // Nov 1 2026 is a fall-back date; naive local-midnight math yields Nov 1
    // twice. These are abstract Pacific day keys, so arithmetic must be exact.
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDay("2026-03-07", 1)).toBe("2026-03-08");
  });
});

describe("coverageOf", () => {
  it("spans the first to last point", () => {
    expect(coverageOf(days("2026-06-30", "2026-07-01", "2026-08-09"))).toEqual({
      from: "2026-06-30",
      to: "2026-08-09",
    });
  });

  it("is null with no points", () => {
    expect(coverageOf([])).toBeNull();
  });
});

describe("resolvePreset", () => {
  const coverage = { from: "2026-06-30", to: "2026-08-09" }; // 41 days

  it("counts back inclusively from the newest day", () => {
    // 7d ending Aug 9 means Aug 3..Aug 9 — seven days, not eight.
    expect(resolvePreset("7d", coverage)).toEqual({ from: "2026-08-03", to: "2026-08-09" });
    expect(rangeLengthDays(resolvePreset("7d", coverage)!)).toBe(7);
  });

  it("returns the whole coverage for all", () => {
    expect(resolvePreset("all", coverage)).toEqual(coverage);
  });

  it("clamps a preset longer than available coverage", () => {
    // 30d is fine within 41 days; 90d would not be.
    expect(resolvePreset("30d", { from: "2026-08-01", to: "2026-08-09" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-09",
    });
  });

  it("is null without coverage", () => {
    expect(resolvePreset("7d", null)).toBeNull();
  });
});

describe("clampRange", () => {
  const coverage = { from: "2026-06-30", to: "2026-08-09" };

  it("pulls both ends inside coverage", () => {
    expect(clampRange({ from: "2026-01-01", to: "2026-12-31" }, coverage)).toEqual(coverage);
  });

  it("leaves an already-valid range alone", () => {
    const r = { from: "2026-07-01", to: "2026-07-10" };
    expect(clampRange(r, coverage)).toEqual(r);
  });

  it("normalises a reversed range rather than returning something empty", () => {
    expect(clampRange({ from: "2026-07-10", to: "2026-07-01" }, coverage)).toEqual({
      from: "2026-07-01",
      to: "2026-07-10",
    });
  });
});

describe("filterPointsToRange", () => {
  it("keeps the endpoints inclusive", () => {
    const pts = days("2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04");
    const kept = filterPointsToRange(pts, { from: "2026-07-02", to: "2026-07-03" });
    expect(kept.map((p) => p.day)).toEqual(["2026-07-02", "2026-07-03"]);
  });

  it("returns everything for the full coverage range", () => {
    const pts = days("2026-07-01", "2026-07-02");
    expect(filterPointsToRange(pts, { from: "2026-07-01", to: "2026-07-02" })).toHaveLength(2);
  });
});

describe("precedingRange", () => {
  it("is the equal-length window ending the day before", () => {
    expect(precedingRange({ from: "2026-08-03", to: "2026-08-09" })).toEqual({
      from: "2026-07-27",
      to: "2026-08-02",
    });
  });

  it("does not overlap the range it precedes", () => {
    const range = { from: "2026-08-03", to: "2026-08-09" };
    const prior = precedingRange(range);
    expect(prior.to < range.from).toBe(true);
    expect(rangeLengthDays(prior)).toBe(rangeLengthDays(range));
  });
});
