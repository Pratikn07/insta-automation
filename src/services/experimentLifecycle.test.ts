import { describe, expect, it } from "vitest";
import {
  resolveExperimentOwnedFlagKeys,
  resolveExperimentState,
  resolveFlagExperimentKey,
} from "./experimentLifecycle.js";

const CUTOVER = "2026-08-21T16:00:00.000Z";

function context(overrides: Partial<Parameters<typeof resolveExperimentState>[1]> = {}) {
  return {
    recoveryVersion: "read-recovery-v1",
    recoveryStartAt: CUTOVER,
    now: new Date("2026-08-21T15:59:59.999Z"),
    ...overrides,
  };
}

describe("recovery experiment lifecycle", () => {
  it("keeps V1 active and V2 planned before the configured cutover", () => {
    expect(resolveExperimentState("recovery-reminder-timing", context())).toBe("running");
    expect(resolveExperimentState("recovery-reminder-timing-v2", context())).toBe("not_started");
  });

  it("does not claim V2 is active just because its version was deployed early", () => {
    const earlyV2 = context({ recoveryVersion: "read-recovery-timing-v2" });

    expect(resolveExperimentState("recovery-reminder-timing", earlyV2)).toBe("running");
    expect(resolveExperimentState("recovery-reminder-timing-v2", earlyV2)).toBe("not_started");
  });

  it("concludes V1 and activates V2 only when version and start time are both in force", () => {
    const active = context({
      recoveryVersion: "read-recovery-timing-v2",
      now: new Date(CUTOVER),
    });

    expect(resolveExperimentState("recovery-reminder-timing", active)).toBe("ended");
    expect(resolveExperimentState("recovery-reminder-timing-v2", active)).toBe("running");
  });

  it("refuses to activate V2 at a differently configured start time", () => {
    const wrongSchedule = context({
      recoveryVersion: "read-recovery-timing-v2",
      recoveryStartAt: "2026-08-22T16:00:00.000Z",
      now: new Date("2026-08-23T16:00:00.000Z"),
    });

    expect(resolveExperimentState("recovery-reminder-timing", wrongSchedule)).toBe("running");
    expect(resolveExperimentState("recovery-reminder-timing-v2", wrongSchedule)).toBe(
      "not_started",
    );
  });

  it("moves only the shared live controls from V1 to V2 at cutover", () => {
    const shared = [
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
    ];
    const legacy = ["DM_RECOVERY_HOLDOUT_PERCENT", "DM_RECOVERY_POST_EXPERIMENT_ENABLED"];
    const before = context();
    const after = context({
      recoveryVersion: "read-recovery-timing-v2",
      now: new Date(CUTOVER),
    });

    expect(resolveExperimentOwnedFlagKeys("recovery-reminder-timing", legacy, before)).toEqual([
      ...legacy,
      ...shared,
    ]);
    expect(resolveExperimentOwnedFlagKeys("recovery-reminder-timing-v2", shared, before)).toEqual(
      [],
    );
    expect(resolveExperimentOwnedFlagKeys("recovery-reminder-timing", legacy, after)).toEqual(
      legacy,
    );
    expect(resolveExperimentOwnedFlagKeys("recovery-reminder-timing-v2", shared, after)).toEqual(
      shared,
    );

    expect(
      resolveFlagExperimentKey("DM_RECOVERY_ENABLED", "recovery-reminder-timing-v2", before),
    ).toBe("recovery-reminder-timing");
    expect(
      resolveFlagExperimentKey("DM_RECOVERY_ENABLED", "recovery-reminder-timing-v2", after),
    ).toBe("recovery-reminder-timing-v2");
    expect(
      resolveFlagExperimentKey(
        "DM_RECOVERY_HOLDOUT_PERCENT",
        "recovery-reminder-timing",
        after,
      ),
    ).toBe("recovery-reminder-timing");
  });

  it("leaves unrelated experiment states unchanged", () => {
    expect(resolveExperimentState("guide-delivery-rollout", context(), "not_started")).toBe(
      "not_started",
    );
  });
});
