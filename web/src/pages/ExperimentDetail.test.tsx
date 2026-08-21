// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentDetailView,
  FlagView,
  RecoveryTimingArm,
  RecoveryTimingArmSummary,
  RecoveryTimingExperimentMetrics,
} from "@/lib/types";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { ExperimentDetail } = await import("./ExperimentDetail");

function renderDetail(key = "recovery-reminder-timing") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Returned, so a test can assert against the whole subtree rather than one node.
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/experiments/${key}`]}>
        <Routes>
          <Route path="/experiments/:key" element={<ExperimentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function ownedFlag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Leaves a public comment.",
    affectsWho: "People sent a guide.",
    ifOff: "No reminders.",
    pageMayEnable: false,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

const RUNNING: ExperimentDetailView = {
  key: "recovery-reminder-timing",
  name: "Recovery reminder timing",
  state: "running",
  doesWhat: "Tests whether leaving a public comment helps when someone never opens the guide.",
  affectsWho: "People sent a guide who have not opened it.",
  outcome: "Whether they received the guide within 48 hours of first asking.",
  arms: [
    { key: "treatment", percent: 90, doesWhat: "Gets a public comment.", isControl: false },
    { key: "control", percent: 10, doesWhat: "Gets nothing.", isControl: true },
  ],
  blocker: "",
  summary: {
    kind: "running",
    arms: [
      { key: "treatment", label: "Got a reminder", people: 594 },
      { key: "control", label: "Got nothing", people: 395 },
    ],
    notCounted: [
      { reason: "They opened it themselves", people: 531 },
      { reason: "Waiting to be posted", people: 54 },
    ],
    endsAt: "2026-08-21T21:45:00.000Z",
    whenItEnds: "When the window closes, reminders stop and wait for your decision.",
  },
  ownedFlags: [ownedFlag()],
};

function timingArm(
  arm: RecoveryTimingArm,
  overrides: Partial<RecoveryTimingArmSummary> = {},
): RecoveryTimingArmSummary {
  return {
    arm,
    assigned: 100,
    allocationPercent: arm === "no_reminder" ? 10 : 45,
    matured: 80,
    immature: 20,
    completedWithin24h: 36,
    completedWithin48h: 48,
    completionRate24h: 45,
    completionRate48h: 60,
    repliedWithin24h: 30,
    repliedWithin48h: 42,
    seenBeforeEligibility: 12,
    sent: arm === "no_reminder" ? 0 : 76,
    attempted: arm === "no_reminder" ? 0 : 78,
    suppressed: arm === "no_reminder" ? 100 : 2,
    suppressionReasons: arm === "no_reminder" ? { experiment_control: 100 } : { completed: 2 },
    sendFailed: arm === "no_reminder" ? 0 : 1,
    sendUncertain: arm === "no_reminder" ? 0 : 1,
    sendExceptionRate: arm === "no_reminder" ? null : 2.6,
    delayedSignalFalsePositives: 1,
    delayedSignalFalsePositiveRate: 1.3,
    reminderToReplyMinutesMedian: arm === "no_reminder" ? null : 95,
    readEventCoveragePercent: 72,
    lateSendCount: arm === "no_reminder" ? 0 : 3,
    latenessMs: { p50: 1_000, p95: 3_000, max: 5_000 },
    cooldownSuppressions: 1,
    duplicateAttemptCount: 0,
    confirmedDuplicateSends: 0,
    ...overrides,
  };
}

const TIMING_METRICS: RecoveryTimingExperimentMetrics = {
  version: "read-recovery-timing-v2",
  reporting: {
    asOf: "2026-08-24T16:00:00.000Z",
    coverage: { from: "2026-08-21", to: "2026-08-24" },
    range: { from: "2026-08-21", to: "2026-08-24" },
    resultsCompleteThrough: "2026-08-22",
    stillCollectingFollowers: 52,
    fullExperimentRange: true,
  },
  arms: {
    twoHour: timingArm("two_hour", {
      assigned: 120,
      matured: 100,
      immature: 20,
      completedWithin24h: 58,
      completionRate24h: 58,
      completedWithin48h: 64,
      completionRate48h: 64,
      repliedWithin48h: 42,
      sendFailed: 1,
      sendUncertain: 1,
      lateSendCount: 3,
      confirmedDuplicateSends: 0,
    }),
    sixHour: timingArm("six_hour", {
      assigned: 121,
      matured: 99,
      immature: 22,
      completedWithin24h: 53,
      completionRate24h: 53.5,
      completedWithin48h: 59,
      completionRate48h: 59.6,
      repliedWithin48h: 39,
      sendFailed: 1,
      sendUncertain: 0,
      lateSendCount: 2,
      confirmedDuplicateSends: 0,
    }),
    noReminder: timingArm("no_reminder", {
      assigned: 51,
      matured: 41,
      immature: 10,
      completedWithin24h: 18,
      completionRate24h: 43.9,
      completedWithin48h: 21,
      completionRate48h: 51.2,
      repliedWithin48h: 14,
      sendFailed: 0,
      sendUncertain: 0,
      lateSendCount: 0,
      confirmedDuplicateSends: 0,
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
    state: "collecting",
    automaticRollout: false,
    conservativeDefault: null,
  },
};

const TIMING_DETAIL: ExperimentDetailView = {
  ...RUNNING,
  key: "recovery-reminder-timing-v2",
  name: "Recovery reminder — 2 vs 6 hours",
  arms: [
    { key: "two_hour", percent: 45, doesWhat: "Gets a reminder after two hours.", isControl: false },
    { key: "six_hour", percent: 45, doesWhat: "Gets a reminder after six hours.", isControl: false },
    { key: "no_reminder", percent: 10, doesWhat: "Gets no reminder.", isControl: true },
  ],
  summary: {
    kind: "running",
    arms: [
      { key: "two_hour", label: "2 hours", people: 120 },
      { key: "six_hour", label: "6 hours", people: 121 },
      { key: "no_reminder", label: "No reminder", people: 51 },
    ],
    notCounted: [],
    endsAt: "2026-10-02T12:00:00.000Z",
    whenItEnds: "When the window closes, reminders stop and wait for your decision.",
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  apiRead.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
});

describe("ExperimentDetail, running", () => {
  it("shows each arm in whole people, with the do-nothing arm", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText("594")).toBeInTheDocument();
    expect(screen.getByText("395")).toBeInTheDocument();
    expect(screen.getByText("Got nothing")).toBeInTheDocument();
  });

  /**
   * No confidence intervals, no significance, no "visitors remaining".
   *
   * The Optimizely screenshots that prompted this design show 285,991 visitors;
   * this has 594 sends. docs/funnels.md already refuses to print a rate its sample
   * cannot support, and none of that machinery transfers to n=594.
   */
  it("prints no statistics", async () => {
    apiRead.mockResolvedValue(RUNNING);
    const { container } = renderDetail();

    await screen.findByText("594");
    expect(container.textContent).not.toMatch(
      /significan|confidence|p-value|uplift|interval|visitors remaining/i,
    );
  });

  it("shows no percentage in the measurements", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    await screen.findByText("594");
    const soFar = screen.getByRole("region", { name: "So far" });
    expect(soFar.textContent).not.toMatch(/%/);
  });

  it("shows who was skipped and why, separately from the arms", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText("They opened it themselves")).toBeInTheDocument();
    expect(screen.getByText("531")).toBeInTheDocument();
    // Named, not folded into a total: these were never reminded and never a control.
    expect(screen.getByText("Waiting to be posted")).toBeInTheDocument();
  });

  it("says when it ends, how long is left, and what happens then", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText(/3 days left/)).toBeInTheDocument();
    expect(screen.getByText(/reminders stop and wait/)).toBeInTheDocument();
  });

  it("lists the switches it owns, each linking to its page", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByRole("link", { name: /Recovery reminders/ })).toHaveAttribute(
      "href",
      "/switches/DM_RECOVERY_ENABLED",
    );
  });

  // A switch's own percentage is its value, not a statistic about the experiment.
  it("shows an owned percentage switch as its percentage", async () => {
    apiRead.mockResolvedValue({
      ...RUNNING,
      ownedFlags: [
        ownedFlag({
          key: "DM_RECOVERY_HOLDOUT_PERCENT",
          name: "Reminder holdout",
          kind: "percent",
          valueBool: null,
          valuePercent: 10,
        }),
      ],
    });
    renderDetail();

    expect(await screen.findByText("10%")).toBeInTheDocument();
  });

  it("carries no control of its own — the switches are where changes happen", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    await screen.findByText("594");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});

describe("ExperimentDetail, 2 vs 6 hour comparison", () => {
  beforeEach(() => {
    apiRead.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/recovery-reminders/metrics"
          ? { timingExperiment: TIMING_METRICS }
          : TIMING_DETAIL,
      ),
    );
  });

  it("compares all three arms in one table with the 48-hour outcome as primary", async () => {
    renderDetail("recovery-reminder-timing-v2");

    const table = await screen.findByRole("table", { name: "Experiment comparison" });
    expect(within(table).getByRole("columnheader", { name: "2 hours" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "6 hours" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "No reminder" })).toBeInTheDocument();

    const primary = within(table).getByRole("row", { name: /Guide completion within 48 hours/i });
    expect(within(primary).getByText("64 / 100 (64.0%)")).toBeInTheDocument();
    expect(within(primary).getByText("59 / 99 (59.6%)")).toBeInTheDocument();
    expect(within(primary).getByText("21 / 41 (51.2%)")).toBeInTheDocument();
    expect(screen.getByText("On a small screen, swipe sideways to compare all three.")).toBeInTheDocument();
  });

  it("shows every direct comparison and a plain-language decision", async () => {
    renderDetail("recovery-reminder-timing-v2");

    expect(await screen.findByText("2 vs 6 hours")).toBeInTheDocument();
    expect(screen.getByText("2 hours vs no reminder")).toBeInTheDocument();
    expect(screen.getByText("6 hours vs no reminder")).toBeInTheDocument();
    expect(screen.getByText("+4.4 pp")).toBeInTheDocument();
    expect(screen.getByText(/Still collecting complete 48-hour results/i)).toBeInTheDocument();
  });

  it("keeps operational safety evidence visible beside the outcome", async () => {
    renderDetail("recovery-reminder-timing-v2");

    const safety = await screen.findByRole("region", { name: "Safety checks" });
    expect(within(safety).getByText("Failed / uncertain sends")).toBeInTheDocument();
    expect(within(safety).getByText("Send exception rate")).toBeInTheDocument();
    expect(within(safety).getByText("Delayed-signal false-positive rate")).toBeInTheDocument();
    expect(within(safety).getByText("Late sends")).toBeInTheDocument();
    expect(within(safety).getByText("Confirmed duplicate sends")).toBeInTheDocument();
  });

  it("names every reason that can force a safety review", async () => {
    const unsafe: RecoveryTimingExperimentMetrics = {
      ...TIMING_METRICS,
      allocation: { indexFollowers: 292, assignmentDriftFollowers: 2 },
      safety: {
        twoHourMateriallyWorse: true,
        sixHourMateriallyWorse: true,
        controlPointEstimateHarm: true,
        treatmentControlConfidenceHarm: true,
        duplicateSafetyEvent: true,
      },
      decision: { state: "safety_review", automaticRollout: false, conservativeDefault: null },
    };
    apiRead.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/recovery-reminders/metrics" ? { timingExperiment: unsafe } : TIMING_DETAIL,
      ),
    );

    renderDetail("recovery-reminder-timing-v2");

    const safety = await screen.findByRole("region", { name: "Safety checks" });
    expect(within(safety).getByText(/Assignment drift: 2 followers/i)).toBeInTheDocument();
    expect(within(safety).getByText(/2-hour arm is materially worse/i)).toBeInTheDocument();
    expect(within(safety).getByText(/6-hour arm is materially worse/i)).toBeInTheDocument();
    expect(within(safety).getByText(/Control point estimate shows harm/i)).toBeInTheDocument();
    expect(within(safety).getByText(/Treatment\/control confidence interval shows harm/i)).toBeInTheDocument();
    expect(within(safety).getByText(/Duplicate-send safety event/i)).toBeInTheDocument();
  });

  it("shows a collecting state when V2 is active but nobody has been assigned yet", async () => {
    apiRead.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/recovery-reminders/metrics" ? { timingExperiment: null } : TIMING_DETAIL,
      ),
    );

    renderDetail("recovery-reminder-timing-v2");

    expect(await screen.findByText(/No assignments yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });
});

describe("ExperimentDetail, scheduled V2", () => {
  it("shows the planned start without asking for result metrics early", async () => {
    const planned: ExperimentDetailView = {
      ...TIMING_DETAIL,
      state: "not_started",
      blocker: "Scheduled for 21 Aug 2026 at 5:00 AM Pacific.",
      summary: {
        kind: "not_started",
        wouldCompare: "A 2-hour reminder versus a 6-hour reminder versus no reminder.",
        blocker: "Scheduled for 21 Aug 2026 at 5:00 AM Pacific.",
      },
    };
    apiRead.mockImplementation((path: string) =>
      path.startsWith("/experiments/")
        ? Promise.resolve(planned)
        : Promise.reject(new Error("metrics requested early")),
    );

    renderDetail("recovery-reminder-timing-v2");

    expect(await screen.findByText("Scheduled for 21 Aug 2026 at 5:00 AM Pacific.")).toBeInTheDocument();
    expect(apiRead).not.toHaveBeenCalledWith(
      expect.stringContaining("/recovery-reminders/metrics"),
      expect.anything(),
    );
  });
});

describe("ExperimentDetail, concluded", () => {
  it("keeps the frozen result and recorded conclusion available", async () => {
    apiRead.mockResolvedValue({
      ...RUNNING,
      state: "ended",
      summary: {
        kind: "ended",
        arms: RUNNING.summary.kind === "running" ? RUNNING.summary.arms : [],
        notCounted: RUNNING.summary.kind === "running" ? RUNNING.summary.notCounted : [],
        endedAt: "2026-08-21T12:00:00.000Z",
        conclusion: "The result was inconclusive, so no winner was declared.",
      },
    } satisfies ExperimentDetailView);

    renderDetail();

    expect(await screen.findByText("Concluded 21 Aug 2026")).toBeInTheDocument();
    expect(screen.getByText("The result was inconclusive, so no winner was declared.")).toBeInTheDocument();
    expect(screen.queryByText(/days left/i)).not.toBeInTheDocument();
  });
});

describe("ExperimentDetail, not started", () => {
  const NOT_STARTED: ExperimentDetailView = {
    ...RUNNING,
    key: "guide-delivery-rollout",
    name: "Guide delivery rollout",
    state: "not_started",
    blocker: "The rollout is at zero, so nobody is on the newer path yet.",
    summary: {
      kind: "not_started",
      wouldCompare: "The newer path versus the older path.",
      blocker: "The rollout is at zero, so nobody is on the newer path yet.",
    },
    ownedFlags: [],
  };

  it("says what it would compare and what is blocking it", async () => {
    apiRead.mockResolvedValue(NOT_STARTED);
    renderDetail("guide-delivery-rollout");

    expect(await screen.findByText(/rollout is at zero/)).toBeInTheDocument();
    expect(screen.getByText(/newer path versus the older path/)).toBeInTheDocument();
    // Zeroes read as failure. This has not failed; it has not started.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows no arm counts and no countdown at all", async () => {
    apiRead.mockResolvedValue(NOT_STARTED);
    renderDetail("guide-delivery-rollout");

    await screen.findByText(/rollout is at zero/);
    expect(screen.queryByRole("region", { name: "So far" })).not.toBeInTheDocument();
    expect(screen.queryByText(/days left|already closed/)).not.toBeInTheDocument();
  });
});

describe("ExperimentDetail, unreachable", () => {
  it("calls a failed read a connection problem, not a missing experiment", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderDetail();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
