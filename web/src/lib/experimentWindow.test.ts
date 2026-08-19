import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people, windowRemaining } from "./experimentWindow";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T21:45:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("windowRemaining", () => {
  it("counts whole days forward", () => {
    expect(windowRemaining("2026-08-21T21:45:00.000Z")).toBe("3 days left");
  });

  it("says one day in the singular", () => {
    expect(windowRemaining("2026-08-19T21:45:00.000Z")).toBe("1 day left");
  });

  // Two hours remaining is not "1 day left". Rounding up would understate the
  // urgency of the one window whose close silently stops sending.
  it("says less than a day when hours remain", () => {
    expect(windowRemaining("2026-08-18T23:59:00.000Z")).toBe("less than a day left");
  });

  it("still says one day at exactly twenty-four hours", () => {
    expect(windowRemaining("2026-08-19T21:45:00.000Z")).toBe("1 day left");
  });

  it("treats the exact closing moment as closed", () => {
    expect(windowRemaining("2026-08-18T21:45:00.000Z")).toBe("already closed");
  });

  // A closed window that counted backwards would read as still running, and this
  // window closing is exactly when reminders stop without announcing it.
  it("never counts backwards past the close", () => {
    expect(windowRemaining("2026-08-01T00:00:00.000Z")).toBe("already closed");
  });

  it("returns nothing when there is no window", () => {
    expect(windowRemaining(null)).toBeNull();
  });

  it("returns nothing rather than NaN for an unparseable date", () => {
    expect(windowRemaining("not a date")).toBeNull();
  });
});

describe("people", () => {
  it("separates thousands", () => {
    expect(people(1958)).toBe("1,958");
  });

  it("leaves a small count alone", () => {
    expect(people(394)).toBe("394");
  });
});
