import { describe, expect, it } from "vitest";
import {
  assignRecoveryTimingArm,
  recoveryTimingBucket,
  timingScheduleForArm,
} from "./dmRecoveryTimingExperiment.js";

describe("DM recovery timing assignment", () => {
  it.each([
    ["fixture-2", "two_hour", 1709],
    ["fixture-0", "six_hour", 5490],
    ["fixture-7", "no_reminder", 9505],
  ] as const)("keeps %s in its frozen %s bucket", (igUserId, arm, bucket) => {
    expect(recoveryTimingBucket(igUserId)).toBe(bucket);
    expect(assignRecoveryTimingArm(igUserId)).toBe(arm);
  });

  it("keeps repeated assignment stable for the same follower", () => {
    expect(assignRecoveryTimingArm("fixture-2")).toBe(
      assignRecoveryTimingArm("fixture-2"),
    );
  });

  it("distributes a large deterministic population near 45/45/10", () => {
    const counts = { two_hour: 0, six_hour: 0, no_reminder: 0 };
    for (let index = 0; index < 100_000; index++) {
      counts[assignRecoveryTimingArm(`synthetic-${index}`)]++;
    }

    expect(counts.two_hour / 1_000).toBeCloseTo(45, 0);
    expect(counts.six_hour / 1_000).toBeCloseTo(45, 0);
    expect(counts.no_reminder / 1_000).toBeCloseTo(10, 0);
    expect(Math.abs(counts.two_hour / 1_000 - 45)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(counts.six_hour / 1_000 - 45)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(counts.no_reminder / 1_000 - 10)).toBeLessThanOrEqual(0.75);
  });
});

describe("DM recovery timing schedules", () => {
  const acceptedAt = new Date("2026-08-16T20:00:00.000Z");

  it("schedules the two-hour treatment from acceptance", () => {
    expect(timingScheduleForArm("two_hour", acceptedAt)).toEqual({
      status: "waiting",
      cohort: "treatment",
      eligibleAt: new Date("2026-08-16T22:00:00.000Z"),
    });
  });

  it("schedules the six-hour treatment from acceptance", () => {
    expect(timingScheduleForArm("six_hour", acceptedAt)).toEqual({
      status: "waiting",
      cohort: "treatment",
      eligibleAt: new Date("2026-08-17T02:00:00.000Z"),
    });
  });

  it("makes the no-reminder arm a terminal control with a non-operative sentinel", () => {
    expect(timingScheduleForArm("no_reminder", acceptedAt)).toEqual({
      status: "control",
      cohort: "control",
      eligibleAt: acceptedAt,
    });
  });

  it("returns a new eligibility Date without mutating acceptance", () => {
    const before = acceptedAt.getTime();
    const schedule = timingScheduleForArm("two_hour", acceptedAt);

    expect(acceptedAt.getTime()).toBe(before);
    expect(schedule.eligibleAt).not.toBe(acceptedAt);
  });
});
