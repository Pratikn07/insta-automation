import { describe, expect, it } from "vitest";
import { chooseStopReason, STOP_THRESHOLDS } from "./historicalRecoveryHealth.js";

// QA-13. `evaluateRecoveryHealth` derives all six of its observations from
// dm_recovery_reminder and never reads recovery_candidate, so a historical campaign could
// be failing on real people's public comments while the shared circuit stayed closed
// because the prospective feature was healthy.
//
// These cover the threshold logic, which is pure. The pausing and the latch are driven
// against real Postgres in historicalRecoveryHealthContract.test.ts.

/** A campaign that has sent cleanly. Each case overrides only what it is testing. */
function healthy(overrides: Record<string, number> = {}) {
  return {
    campaignId: "camp-1",
    settled: 20,
    sent: 20,
    failed: 0,
    uncertain: 0,
    sourceUnavailable: 0,
    duplicatePeople: 0,
    complaints: 0,
    optOuts: 0,
    blocks: 0,
    negativeReplies: 0,
    classifierAnomalies: 0,
    ...overrides,
  };
}

describe("chooseStopReason", () => {
  it("does not stop a campaign that is sending cleanly", () => {
    expect(chooseStopReason(healthy())).toBeNull();
  });

  it.each([
    ["complaints", "complaint"],
    ["optOuts", "opt_out"],
    ["blocks", "block"],
    ["classifierAnomalies", "classifier_anomaly"],
    ["negativeReplies", "negative_reply"],
  ] as const)("stops immediately on %s", (field, reason) => {
    expect(chooseStopReason(healthy({ [field]: 1 }))).toBe(reason);
  });

  it("reports a complaint ahead of duplicate contact and rates", () => {
    expect(chooseStopReason(healthy({ complaints: 1, duplicatePeople: 1, failed: 20 })))
      .toBe("complaint");
  });

  // The worst possible failure: two public comments to one person. Reported ahead of any
  // rate because it is a visible mistake on someone's post, not a statistic.
  it("stops on a duplicate public reply, whatever the rates say", () => {
    expect(chooseStopReason(healthy({ duplicatePeople: 1 }))).toBe("duplicate_public_reply");
  });

  it("reports a duplicate ahead of a failure rate", () => {
    expect(
      chooseStopReason(healthy({ duplicatePeople: 1, sent: 0, failed: 20 })),
    ).toBe("duplicate_public_reply");
  });

  // A duplicate is worth stopping for even below the sample floor: it is not a rate.
  it("stops on a duplicate even with almost no sample", () => {
    expect(
      chooseStopReason(healthy({ settled: 2, sent: 2, duplicatePeople: 1 })),
    ).toBe("duplicate_public_reply");
  });

  describe("rate checks need a sample", () => {
    // Without a floor the first failure of a 3-send stage-0 campaign reads as a 33%
    // failure rate and stops it before it has begun.
    it("stays silent below the minimum sample", () => {
      expect(chooseStopReason(healthy({ settled: 2, sent: 1, failed: 1 }))).toBeNull();
    });

    it("fires at exactly the minimum sample", () => {
      const settled = STOP_THRESHOLDS.minSample;
      expect(
        chooseStopReason(healthy({ settled, sent: 0, failed: settled })),
      ).toBe("public_failure_rate");
    });
  });

  describe("public failure rate", () => {
    it("stops when Meta is rejecting our replies", () => {
      expect(
        chooseStopReason(healthy({ settled: 10, sent: 8, failed: 2 })),
      ).toBe("public_failure_rate");
    });

    // At the threshold exactly, not just past it: a boundary that only fires above the
    // number silently tolerates the configured limit.
    it("fires at the threshold, not only above it", () => {
      expect(
        chooseStopReason(healthy({ settled: 100, sent: 80, failed: STOP_THRESHOLDS.failurePercent })),
      ).toBe("public_failure_rate");
    });

    it("tolerates a failure rate just under the threshold", () => {
      expect(
        chooseStopReason(healthy({ settled: 100, sent: 81, failed: STOP_THRESHOLDS.failurePercent - 1 })),
      ).toBeNull();
    });
  });

  describe("uncertain rate", () => {
    // A lower threshold than failure on purpose: a failed send definitely posted nothing,
    // an uncertain one may have posted publicly and we cannot tell.
    it("has a stricter threshold than plain failure", () => {
      expect(STOP_THRESHOLDS.uncertainPercent).toBeLessThan(STOP_THRESHOLDS.failurePercent);
    });

    it("stops when too many outcomes are unknown", () => {
      expect(
        chooseStopReason(healthy({ settled: 20, sent: 18, uncertain: 2 })),
      ).toBe("uncertain_rate");
    });

    // A rate under the failure threshold but over the uncertainty one must still stop.
    it("catches uncertainty that the failure threshold would allow", () => {
      const o = healthy({ settled: 100, sent: 85, uncertain: 15 });
      expect(chooseStopReason(o)).toBe("uncertain_rate");
    });
  });

  describe("source availability", () => {
    // Measured against everything TOUCHED, not just what sent: a decayed cohort shows up
    // as suppressions, which never reach the settled count at all. Counting only settled
    // rows would make a campaign whose comments have all been deleted look perfect.
    it("stops when the cohort has decayed", () => {
      expect(
        chooseStopReason(healthy({ settled: 5, sent: 5, sourceUnavailable: 10 })),
      ).toBe("source_unavailable_rate");
    });

    it("tolerates a few missing comments", () => {
      expect(
        chooseStopReason(healthy({ settled: 20, sent: 20, sourceUnavailable: 2 })),
      ).toBeNull();
    });

    // With nothing sent yet, suppressions alone must still be able to stop the campaign —
    // otherwise a cohort that is entirely gone sends nothing and never reports why.
    it("stops on suppressions alone before anything has sent", () => {
      expect(
        chooseStopReason(healthy({ settled: 0, sent: 0, sourceUnavailable: 10 })),
      ).toBe("source_unavailable_rate");
    });

    it("stays silent when the touched sample is too small", () => {
      expect(
        chooseStopReason(healthy({ settled: 0, sent: 0, sourceUnavailable: 2 })),
      ).toBeNull();
    });
  });

  // Thresholds govern public comments on real people's posts, so the defaults must be
  // conservative. Pinned so a future edit that loosens them is a visible decision.
  it("keeps conservative defaults", () => {
    expect(STOP_THRESHOLDS.failurePercent).toBeLessThanOrEqual(20);
    expect(STOP_THRESHOLDS.uncertainPercent).toBeLessThanOrEqual(10);
    expect(STOP_THRESHOLDS.minSample).toBeLessThanOrEqual(5);
  });
});
