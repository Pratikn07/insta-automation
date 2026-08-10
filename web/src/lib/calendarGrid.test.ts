import { describe, expect, it } from "vitest";
import { buildMonthGrid, monthLabel, shiftMonth } from "./calendarGrid";

describe("buildMonthGrid", () => {
  it("lays out a month starting on the correct weekday", () => {
    // 2026-08-01 is a Saturday, so the first row has six leading blanks.
    const grid = buildMonthGrid("2026-08");
    expect(grid.weeks[0]!.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(grid.weeks[0]![6]).toMatchObject({ day: "2026-08-01" });
  });

  it("contains every day of the month exactly once, in order", () => {
    const days = buildMonthGrid("2026-07")
      .weeks.flat()
      .filter((c) => c !== null)
      .map((c) => c!.day);
    expect(days).toHaveLength(31);
    expect(days[0]).toBe("2026-07-01");
    expect(days[30]).toBe("2026-07-31");
    expect([...days].sort()).toEqual(days);
  });

  it("handles a leap February", () => {
    const days = buildMonthGrid("2028-02")
      .weeks.flat()
      .filter((c) => c !== null);
    expect(days).toHaveLength(29);
  });

  it("pads only with nulls, never with neighbouring months", () => {
    for (const cell of buildMonthGrid("2026-08").weeks.flat()) {
      if (cell) expect(cell.day.startsWith("2026-08")).toBe(true);
    }
  });

  it("emits whole weeks of seven", () => {
    for (const week of buildMonthGrid("2026-08").weeks) {
      expect(week).toHaveLength(7);
    }
  });
});

describe("shiftMonth", () => {
  it("moves across a year boundary in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("moves within a year", () => {
    expect(shiftMonth("2026-08", -1)).toBe("2026-07");
  });
});

describe("monthLabel", () => {
  it("names the month and year without timezone drift", () => {
    // A local-time parse of "2026-08" west of UTC lands in July.
    expect(monthLabel("2026-08")).toContain("2026");
    expect(monthLabel("2026-08")).toMatch(/Aug/);
  });
});
