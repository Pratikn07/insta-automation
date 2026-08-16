import { describe, expect, it } from "vitest";
import { composeTodaysRead, velocityChange } from "./todaysRead";
import type { UsWeekOverWeek } from "./followerFlow";
import type { GuideFollowResult } from "./types";

const week = (over: Partial<UsWeekOverWeek> = {}): UsWeekOverWeek =>
  ({
    thisWeek: 248,
    lastWeek: 189,
    trend: "accelerating",
    provisionalDays: 0,
    ...over,
  }) as UsWeekOverWeek;

const funnel = (pct: number | null, numerator = 1267, denominator = 2946) =>
  ({
    headline: { label: "Reply rate", rate: { numerator, denominator, pct } },
  }) as GuideFollowResult;

describe("velocityChange", () => {
  it("rounds the percent change against the prior week", () => {
    expect(velocityChange(248, 189)).toBe(31);
  });

  it("returns null without a baseline", () => {
    expect(velocityChange(248, null)).toBeNull();
  });

  it("refuses a ratio against zero rather than reporting an infinite rise", () => {
    expect(velocityChange(248, 0)).toBeNull();
  });
});

describe("composeTodaysRead", () => {
  it("returns null when there is no follower geography to read", () => {
    expect(composeTodaysRead(null, funnel(43))).toBeNull();
  });

  it("states the change when a comparable week exists", () => {
    const read = composeTodaysRead(week(), funnel(43))!;
    expect(read.headline).toBe("US follower growth is 31% faster than last week.");
  });

  it("names a fall as slower rather than hiding the direction", () => {
    const read = composeTodaysRead(week({ thisWeek: 150, lastWeek: 200 }), undefined)!;
    expect(read.headline).toContain("25% slower");
  });

  it("falls back to counts, and never a percentage, without a baseline", () => {
    const read = composeTodaysRead(week({ lastWeek: null }), undefined)!;
    expect(read.headline).toBe("You gained 248 US followers this week.");
    expect(read.headline).not.toContain("%");
    expect(read.qualification).toContain("No comparable prior week");
  });

  it("quotes the funnel's loss in counts, not as a rate", () => {
    const read = composeTodaysRead(week(), funnel(43))!;
    expect(read.because).toContain("1,679 of 2,946");
    expect(read.because).not.toContain("%");
  });

  it("omits the clause when nothing is being lost", () => {
    expect(composeTodaysRead(week(), funnel(100, 2946, 2946))!.because).toBeNull();
  });

  it("says the sample is below minimum when the funnel withholds its rate", () => {
    const read = composeTodaysRead(week(), funnel(null, 5, 32))!;
    expect(read.qualification).toContain("below the minimum sample");
  });

  it("declares settling days so the reader can discount them", () => {
    const read = composeTodaysRead(week({ provisionalDays: 2 }), undefined)!;
    expect(read.qualification).toContain("newest 2 days still settling");
  });
});
