// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RecoveryTimingArm,
  RecoveryTimingArmSummary,
  RecoveryTimingExperimentMetrics,
} from "../../lib/types";
import { DmRecoveryTimingSummary } from "./DmRecoveryTimingSummary";

function arm(
  timingArm: RecoveryTimingArm,
  overrides: Partial<RecoveryTimingArmSummary> = {},
): RecoveryTimingArmSummary {
  return {
    arm: timingArm,
    assigned: 100,
    allocationPercent: timingArm === "no_reminder" ? 10 : 45,
    matured: 80,
    immature: 20,
    completedWithin24h: 36,
    completedWithin48h: 48,
    completionRate24h: 45,
    completionRate48h: 60,
    repliedWithin24h: 30,
    repliedWithin48h: 42,
    seenBeforeEligibility: 12,
    sent: timingArm === "no_reminder" ? 0 : 76,
    attempted: timingArm === "no_reminder" ? 0 : 78,
    suppressed: timingArm === "no_reminder" ? 100 : 2,
    suppressionReasons: timingArm === "no_reminder" ? { experiment_control: 100 } : { completed: 2 },
    sendFailed: timingArm === "no_reminder" ? 0 : 1,
    sendUncertain: timingArm === "no_reminder" ? 0 : 1,
    sendExceptionRate: timingArm === "no_reminder" ? null : 2.6,
    delayedSignalFalsePositives: 1,
    delayedSignalFalsePositiveRate: 1.3,
    reminderToReplyMinutesMedian: timingArm === "no_reminder" ? null : 95,
    readEventCoveragePercent: 72,
    lateSendCount: timingArm === "no_reminder" ? 0 : 3,
    latenessMs: { p50: 1_000, p95: 3_000, max: 5_000 },
    cooldownSuppressions: 1,
    duplicateAttemptCount: 0,
    confirmedDuplicateSends: 0,
    ...overrides,
  };
}

const METRICS: RecoveryTimingExperimentMetrics = {
  version: "read-recovery-timing-v2",
  reporting: {
    asOf: "2026-08-16T19:00:00.000Z",
    coverage: { from: "2026-07-01", to: "2026-08-16" },
    range: { from: "2026-08-01", to: "2026-08-16" },
    resultsCompleteThrough: "2026-08-13",
    stillCollectingFollowers: 92,
    fullExperimentRange: false,
  },
  arms: {
    twoHour: arm("two_hour", {
      assigned: 120,
      matured: 100,
      immature: 20,
      completedWithin48h: 64,
      completionRate48h: 64,
      attempted: 98,
      sent: 96,
      sendFailed: 1,
      sendUncertain: 1,
    }),
    sixHour: arm("six_hour", {
      assigned: 121,
      matured: 99,
      immature: 22,
      completedWithin48h: 59,
      completionRate48h: 59.6,
      attempted: 96,
      sent: 95,
      sendFailed: 1,
      sendUncertain: 0,
    }),
    noReminder: arm("no_reminder", {
      assigned: 51,
      matured: 41,
      immature: 10,
      completedWithin48h: 21,
      completionRate48h: 51.2,
    }),
  },
  timingComparison: {
    differencePercentagePoints: 4.4,
    confidenceInterval95: { low: 1.1, high: 7.7 },
    zScore: 2.4,
    pValue: 0.016,
  },
  treatmentControlComparisons: {
    twoHour: {
      differencePercentagePoints: 12.8,
      confidenceInterval95: { low: 4.2, high: 21.4 },
      zScore: 2.7,
      pValue: 0.007,
    },
    sixHour: {
      differencePercentagePoints: 8.4,
      confidenceInterval95: { low: -0.1, high: 16.9 },
      zScore: 1.9,
      pValue: 0.057,
    },
  },
  allocation: { indexFollowers: 292, assignmentDriftFollowers: 0 },
  safety: {
    twoHourMateriallyWorse: false,
    sixHourMateriallyWorse: false,
    controlPointEstimateHarm: false,
    treatmentControlConfidenceHarm: false,
    duplicateSafetyEvent: false,
  },
  decision: {
    state: "exploratory",
    automaticRollout: false,
    conservativeDefault: null,
  },
};

afterEach(cleanup);

describe("DmRecoveryTimingSummary", () => {
  it("renders the API-owned reporting window, maturity, arms, and comparison", () => {
    render(<DmRecoveryTimingSummary metrics={METRICS} />);

    expect(screen.getByText("Showing guide requests received Aug 1 to Aug 16.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Results are complete through Aug 13. 92 followers are still collecting 48-hour outcomes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2-hour reminder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "6-hour reminder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No reminder" })).toBeInTheDocument();
    expect(screen.getByText("64.0%", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("59.6%", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("51.2%", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("+4.4 percentage points")).toBeInTheDocument();
    expect(screen.getByText("95% CI: +1.1 to +7.7 percentage points")).toBeInTheDocument();
    expect(screen.getByText("Intentionally withheld for comparison.")).toBeInTheDocument();
    expect(screen.getByText("Attempted 98 · Sent 96 · Failed 1 · Uncertain 1")).toBeInTheDocument();
  });

  it("does not declare a winner for an exploratory date slice", () => {
    render(<DmRecoveryTimingSummary metrics={METRICS} />);

    expect(screen.getByText(/Exploratory view/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Final winner:/i)).not.toBeInTheDocument();
  });

  it("explains an inconclusive final result", () => {
    render(
      <DmRecoveryTimingSummary
        metrics={{
          ...METRICS,
          decision: {
            state: "inconclusive",
            automaticRollout: false,
            conservativeDefault: "six_hour",
          },
        }}
      />,
    );

    expect(screen.getByText(/Final result is inconclusive/i)).toBeInTheDocument();
    expect(screen.getByText(/6-hour reminder is the conservative default/i)).toBeInTheDocument();
  });

  it("stops at safety review when the API reports a guardrail", () => {
    render(
      <DmRecoveryTimingSummary
        metrics={{
          ...METRICS,
          safety: { ...METRICS.safety, duplicateSafetyEvent: true },
          decision: { ...METRICS.decision, state: "safety_review" },
        }}
      />,
    );

    expect(screen.getByText(/Safety review required/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicate reminder send was confirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Final winner:/i)).not.toBeInTheDocument();
  });

  it.each([
    ["two_hour_wins", "2-hour reminder"],
    ["six_hour_wins", "6-hour reminder"],
  ] as const)("shows a final winner only for %s", (state, label) => {
    render(
      <DmRecoveryTimingSummary
        metrics={{ ...METRICS, decision: { ...METRICS.decision, state } }}
      />,
    );

    expect(screen.getByText(`Final winner: ${label}.`)).toBeInTheDocument();
  });
});
