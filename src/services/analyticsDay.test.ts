import { describe, expect, it } from "vitest";
import {
  ANALYTICS_TIME_ZONE,
  analyticsDayBounds,
  calendarDaysBetween,
  dayKeyToSqlDate,
  enumerateDayKeys,
  isDayKey,
  shiftDayKey,
  sqlDateToDayKey,
  toAnalyticsDayKey,
} from "./analyticsDay.js";

describe("Pacific analytics calendar", () => {
  it("uses the Los Angeles IANA timezone", () => {
    expect(ANALYTICS_TIME_ZONE).toBe("America/Los_Angeles");
  });

  it("places an August UTC-midnight refresh on the preceding Pacific day", () => {
    expect(toAnalyticsDayKey(new Date("2026-08-06T00:05:08Z"))).toBe("2026-08-05");
  });

  it("uses the winter UTC-8 boundary", () => {
    expect(toAnalyticsDayKey(new Date("2026-01-01T07:59:59Z"))).toBe("2025-12-31");
    expect(toAnalyticsDayKey(new Date("2026-01-01T08:00:00Z"))).toBe("2026-01-01");
  });

  it("returns a 23-hour spring-forward day", () => {
    const bounds = analyticsDayBounds("2026-03-08");
    expect(bounds.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(bounds.endExclusive.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(bounds.endExclusive.getTime() - bounds.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("returns a 25-hour fall-back day", () => {
    const bounds = analyticsDayBounds("2026-11-01");
    expect(bounds.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(bounds.endExclusive.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(bounds.endExclusive.getTime() - bounds.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("shifts abstract calendar keys across both DST transitions", () => {
    expect(shiftDayKey("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDayKey("2026-11-01", 1)).toBe("2026-11-02");
    expect(calendarDaysBetween("2026-03-07", "2026-03-10")).toBe(3);
    expect(enumerateDayKeys("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("round-trips canonical SQL date values without timezone conversion", () => {
    expect(dayKeyToSqlDate("2026-08-05")).toEqual(new Date("2026-08-05T00:00:00Z"));
    expect(sqlDateToDayKey(new Date("2026-08-05T00:00:00Z"))).toBe("2026-08-05");
  });

  it("rejects malformed and impossible day keys", () => {
    expect(isDayKey("2026-08-05")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(() => analyticsDayBounds("08/05/2026")).toThrow("invalid_analytics_day");
  });
});
