// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RecoveryReminderRow,
  RecoveryTimingArm,
  RecoveryTimingArmSummary,
  RecoveryTimingExperimentMetrics,
} from "../../lib/types";

const list = vi.fn();
const counts = vi.fn();
const metrics = vi.fn();
const apiGet = vi.fn();
const settingsVerifications = vi.fn();
const activateSettingsVerification = vi.fn();

vi.mock("../../lib/api", () => ({
  // The keyword filter's options come from the generic client, not recoveryApi.
  api: (path: string) => apiGet(path),
  apiRead: (path: string) => apiGet(path),
  apiMutation: (...a: unknown[]) => apiGet(...a),
  recoveryApi: {
    // These tests exercise query construction. Request cancellation is covered
    // by the API client tests, so keep the spies focused on the query argument.
    list: (query: unknown) => list(query),
    counts: (query: unknown) => counts(query),
    metrics: (query: unknown) => metrics(query),
    settingsVerifications: () => settingsVerifications(),
    activateSettingsVerification: (id: string) => activateSettingsVerification(id),
  },
}));

const { DmRecoveryList, CIRCUIT_PAUSED_MESSAGE } = await import("./DmRecoveryList");

function row(overrides: Partial<RecoveryReminderRow> = {}): RecoveryReminderRow {
  return {
    id: "rec-1",
    conversationId: "convo-1",
    igUserId: "ig-1",
    username: "sarah",
    name: "Sarah",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    media: { id: "media-1", permalink: "https://instagram.com/p/x", caption: "Sleep reel" },
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    experimentVersion: null,
    timingArm: null,
    timingLabel: null,
    acceptedAt: "2026-08-06T00:00:00.000Z",
    eligibleAt: "2026-08-06T10:00:00.000Z",
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: "2026-08-05T23:00:00.000Z",
    settingsEvidence: null,
    ...overrides,
  };
}

const COUNTS = {
  all: { records: 21, people: 18 },
  scheduled: { records: 6, people: 6 },
  ready: { records: 3, people: 2 },
  sent: { records: 5, people: 5 },
  suppressed: { records: 4, people: 3 },
  control: { records: 2, people: 2 },
  attention: { records: 1, people: 1 },
};

const HEALTHY = { health: { circuitOpen: false, reason: null, dueCount: 3 } };

const cohortSummary = {
  eligiblePeople: 40,
  eligibleJourneys: 44,
  repliedWithin24h: 10,
  repliedWithin48h: 12,
  completedWithin24h: 8,
  completedWithin48h: 10,
  completionRate48h: 25,
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
    suppressionReasons: arm === "no_reminder" ? { experiment_control: 100 } : {},
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

const TIMING_EXPERIMENT: RecoveryTimingExperimentMetrics = {
  version: "read-recovery-timing-v2",
  reporting: {
    asOf: "2026-08-17T03:00:00.000Z",
    coverage: { from: "2026-07-01", to: "2026-08-16" },
    range: { from: "2026-07-18", to: "2026-08-16" },
    resultsCompleteThrough: "2026-08-14",
    stillCollectingFollowers: 60,
    fullExperimentRange: false,
  },
  arms: {
    twoHour: timingArm("two_hour"),
    sixHour: timingArm("six_hour"),
    noReminder: timingArm("no_reminder"),
  },
  timingComparison: {
    differencePercentagePoints: 3.2,
    confidenceInterval95: { low: -1.1, high: 7.5 },
    zScore: 1.4,
    pValue: 0.16,
  },
  treatmentControlComparisons: {
    twoHour: {
      differencePercentagePoints: 4,
      confidenceInterval95: { low: -2, high: 10 },
      zScore: 1.2,
      pValue: 0.23,
    },
    sixHour: {
      differencePercentagePoints: 1,
      confidenceInterval95: { low: -5, high: 7 },
      zScore: 0.3,
      pValue: 0.76,
    },
  },
  allocation: { indexFollowers: 300, assignmentDriftFollowers: 0 },
  safety: {
    twoHourMateriallyWorse: false,
    sixHourMateriallyWorse: false,
    controlPointEstimateHarm: false,
    treatmentControlConfidenceHarm: false,
    duplicateSafetyEvent: false,
  },
  decision: { state: "exploratory", automaticRollout: false, conservativeDefault: null },
};

const METRICS = {
  ...HEALTHY,
  timingExperiment: TIMING_EXPERIMENT,
  experiment: {
    version: "v1",
    startAt: null,
    endAt: null,
    treatment: { ...cohortSummary, completionRate48h: 31.5, sent: 30 },
    control: { ...cohortSummary, withheld: 4 },
    absoluteLiftPercentagePoints: 6.5,
    relativeLiftPercent: 26,
    medianReminderToReplyMinutes: 42,
    byKeyword: [],
  },
  accuracy: {
    eventualRepliers: 12,
    eventualRepliersWithPriorSeen: 3,
    readEventCoverage: 61.2,
    sent: 30,
    laterSeen: 9,
    laterEngaged: 7,
    laterCompleted: 5,
    delayedPreSendSignalFalsePositives: 0,
    withoutLaterPositiveEvidence: 18,
    uncertain: 1,
    duplicateAttempts: 0,
    cooldownSuppressions: 2,
    staleLeases: 0,
    failed: 1,
    settingsClassifierMatches: 4,
  },
  settingsEvidence: {
    current: 1,
    stale: 1,
    retired: 0,
    missing: 1,
    byVerification: [],
  },
};

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DmRecoveryList onSelect={vi.fn()} />
    </QueryClientProvider>,
  );
}

// This project does not run vitest with `globals: true`, so Testing Library's
// automatic cleanup never registers and renders leak between tests.
afterEach(cleanup);

beforeEach(() => {
  list.mockReset().mockResolvedValue({ rows: [row()], nextCursor: null });
  counts.mockReset().mockResolvedValue(COUNTS);
  apiGet.mockReset().mockResolvedValue([
    { id: "kw-1", keyword: "SLEEP" },
    { id: "kw-2", keyword: "CALM" },
  ]);
  metrics.mockReset().mockImplementation(async (query = "") => {
    if (!query) return METRICS;
    const params = new URLSearchParams(String(query));
    return {
      ...METRICS,
      timingExperiment: {
        ...TIMING_EXPERIMENT,
        reporting: {
          ...TIMING_EXPERIMENT.reporting,
          range: {
            from: params.get("from") ?? TIMING_EXPERIMENT.reporting.range.from,
            to: params.get("to") ?? TIMING_EXPERIMENT.reporting.range.to,
          },
        },
      },
    };
  });
  settingsVerifications.mockReset().mockResolvedValue({ records: [] });
  activateSettingsVerification.mockReset().mockResolvedValue(undefined);
});

describe("DmRecoveryList", () => {
  it("loads metrics first, then gives counts and rows the identical server scope", async () => {
    let release!: (value: typeof METRICS) => void;
    metrics.mockReset().mockReturnValue(
      new Promise<typeof METRICS>((resolve) => {
        release = resolve;
      }),
    );

    renderList();
    await waitFor(() => expect(metrics).toHaveBeenCalledWith(""));
    expect(counts).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();

    await act(async () => release(METRICS));

    const scope =
      "from=2026-07-18&to=2026-08-16&asOf=2026-08-17T03%3A00%3A00.000Z";
    await waitFor(() => expect(counts).toHaveBeenCalledWith(scope));
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.stringContaining(scope)));
  });

  it("surfaces a metrics failure and retries before loading scoped data", async () => {
    metrics.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(METRICS);
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn’t load recovery reporting/i);
    expect(counts).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Recovery timing" })).toBeInTheDocument();
    await waitFor(() => expect(counts).toHaveBeenCalled());
    await waitFor(() => expect(list).toHaveBeenCalled());
  });

  it("uses the server asOf when describing whether a scoped row is due", async () => {
    metrics.mockResolvedValue({
      ...METRICS,
      timingExperiment: {
        ...TIMING_EXPERIMENT,
        reporting: {
          ...TIMING_EXPERIMENT.reporting,
          asOf: "2020-01-01T00:00:00.000Z",
          coverage: { from: "2019-12-01", to: "2020-01-01" },
          range: { from: "2019-12-03", to: "2020-01-01" },
          resultsCompleteThrough: "2019-12-29",
        },
      },
    });
    list.mockResolvedValue({
      rows: [
        row({
          acceptedAt: "2019-12-31T22:00:00.000Z",
          eligibleAt: "2020-01-01T01:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });

    renderList();

    expect(await screen.findByText("Waiting for read confirmation")).toBeInTheDocument();
    expect(screen.queryByText("No confirmed read")).not.toBeInTheDocument();
  });

  it("starts at 30 days and exposes presets plus a custom date range", async () => {
    renderList();

    for (const name of ["7d", "14d", "30d", "All", "Custom"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Showing guide requests received Jul 18 to Aug 16.")).toBeInTheDocument();
  });

  it("refetches metrics before moving rows and counts to a selected preset", async () => {
    renderList();
    await screen.findByText("@sarah");

    await userEvent.click(screen.getByRole("button", { name: "7d" }));

    const scope =
      "from=2026-08-10&to=2026-08-16&asOf=2026-08-17T03%3A00%3A00.000Z";
    await waitFor(() => expect(metrics).toHaveBeenCalledWith(scope));
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith(scope));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.stringContaining(scope)));
  });

  it("commits a custom date range through metrics before moving the list", async () => {
    renderList();
    await screen.findByRole("button", { name: "Custom" });

    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a date range" });
    await userEvent.click(within(dialog).getByRole("button", { name: "2026-08-01" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2026-08-05" }));

    const scope =
      "from=2026-08-01&to=2026-08-05&asOf=2026-08-17T03%3A00%3A00.000Z";
    await waitFor(() => expect(metrics).toHaveBeenCalledWith(scope));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.stringContaining(scope)));
  });

  it("renders all three timing cards", async () => {
    renderList();
    expect(await screen.findByRole("heading", { name: "2-hour reminder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "6-hour reminder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No reminder" })).toBeInTheDocument();
  });

  it("shows health and legacy metrics when v2 has no requests yet", async () => {
    metrics.mockResolvedValue({ ...METRICS, timingExperiment: null });
    renderList();

    expect(await screen.findByText(/No recovery timing requests yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Treatment 48h/i)).toBeInTheDocument();
    expect(screen.queryByText(CIRCUIT_PAUSED_MESSAGE)).not.toBeInTheDocument();
  });

  it("shows a view tab per state with its record count", async () => {
    renderList();
    for (const label of [
      "Scheduled",
      "Due",
      "Sent publicly",
      "Suppressed",
      "Control",
      "Attention",
    ]) {
      expect(await screen.findByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("summarises people and journeys separately", async () => {
    renderList();
    expect(await screen.findByText("2 people · 3 journeys")).toBeInTheDocument();
  });

  // The product's central claim. Meta exposes no unread signal, so a due row
  // reports the absence of a receipt, never the state of the message.
  it("says No confirmed read and never Unread", async () => {
    list.mockResolvedValue({ rows: [row({ eligibleAt: "2020-01-01T00:00:00.000Z" })], nextCursor: null });
    const { container } = renderList();

    expect(await screen.findByText("No confirmed read")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bUnread\b/);
  });

  it("renders Due as the automation state beside the read evidence", async () => {
    list.mockResolvedValue({
      rows: [row({ eligibleAt: "2020-01-01T00:00:00.000Z" })],
      nextCursor: null,
    });
    renderList();

    const reminder = await screen.findByRole("button", { name: /@sarah/ });
    expect(reminder).toHaveTextContent("Due");
    expect(reminder).toHaveTextContent("No confirmed read");
  });

  it("renders Scheduled before the eligibility time", async () => {
    list.mockResolvedValue({
      rows: [row({ eligibleAt: "2099-01-01T00:00:00.000Z" })],
      nextCursor: null,
    });
    renderList();

    expect(await screen.findByRole("button", { name: /@sarah/ })).toHaveTextContent(
      "Scheduled",
    );
  });

  it("refetches with the selected view", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole("button", { name: /Attention/ }));

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(expect.stringContaining("view=attention"));
    });
  });

  it("renders an empty state rather than a bare table", async () => {
    list.mockResolvedValue({ rows: [], nextCursor: null });
    renderList();
    expect(await screen.findByText(/No recovery reminders/i)).toBeInTheDocument();
  });

  it("surfaces a load failure with a retry", async () => {
    list.mockRejectedValue(new Error("boom"));
    renderList();
    expect(await screen.findByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("shows current and invalid settings evidence totals", async () => {
    renderList();
    expect(await screen.findByText("1 current · 2 invalid settings evidence")).toBeInTheDocument();
  });

  it("keeps reminders usable when the settings registry response is incomplete", async () => {
    settingsVerifications.mockResolvedValue({});

    renderList();

    expect(await screen.findByText("@sarah")).toBeInTheDocument();
    expect(screen.queryByText("Settings verification registry")).not.toBeInTheDocument();
  });

  it("labels a stale settings reminder in the row", async () => {
    list.mockResolvedValue({
      rows: [
        row({
          triggerKind: "settings_blocked",
          cohort: "not_applicable",
          settingsEvidence: {
            status: "stale",
            verificationId: "10000000-0000-4000-8000-000000000017",
            version: "settings-proof-v1",
            graphCode: 10,
            graphSubcode: 12345,
            classifiedAt: "2026-08-06T09:00:00Z",
            verifiedAt: "2026-08-06T08:00:00Z",
            validUntil: "2026-08-07T08:00:00Z",
            apiVersion: "v23.0",
            evidenceReference: "safe/ref",
            evidenceSha256: "a".repeat(64),
          },
        }),
      ],
      nextCursor: null,
    });

    renderList();
    expect(await screen.findByText("Evidence stale")).toBeInTheDocument();
  });

  it("offers activation only for a valid inactive registry record", async () => {
    settingsVerifications.mockResolvedValue({
      records: [
        {
          id: "10000000-0000-4000-8000-000000000017",
          version: "ready-v1",
          graphCode: 10,
          graphSubcode: 12345,
          status: "inactive",
          verifiedAt: "2026-08-06T08:00:00Z",
          validUntil: "2099-08-06T08:00:00Z",
          apiVersion: "v23.0",
          evidenceReference: "safe/ready",
          evidenceSha256: "a".repeat(64),
          active: false,
          retiredAt: null,
          retirementReason: null,
        },
        {
          id: "20000000-0000-4000-8000-000000000017",
          version: "stale-v1",
          graphCode: 10,
          graphSubcode: 99999,
          status: "stale",
          verifiedAt: "2026-01-01T00:00:00Z",
          validUntil: "2026-01-02T00:00:00Z",
          apiVersion: "v23.0",
          evidenceReference: "safe/stale",
          evidenceSha256: "b".repeat(64),
          active: false,
          retiredAt: null,
          retirementReason: null,
        },
      ],
    });

    renderList();
    const activate = await screen.findByRole("button", { name: "Activate ready-v1" });
    expect(screen.queryByRole("button", { name: "Activate stale-v1" })).not.toBeInTheDocument();
    await userEvent.click(activate);
    await waitFor(() =>
      expect(activateSettingsVerification).toHaveBeenCalledWith(
        "10000000-0000-4000-8000-000000000017",
      ),
    );
  });

  it("pages with the cursor", async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce({ rows: [row({ id: "a" })], nextCursor: "cursor-2" });
    list.mockResolvedValueOnce({ rows: [row({ id: "b", username: "mo" })], nextCursor: null });

    renderList();
    await user.click(await screen.findByRole("button", { name: /Load more/i }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(expect.stringContaining("cursor=cursor-2"));
    });
  });

  // The scheduled/ready split is an eligibleAt comparison against a timestamp.
  // Letting the server pick a fresh one per page moved the boundary between
  // pages, and a row that crossed it appeared on neither, so page 1's boundary
  // has to travel with the cursor.
  it("reuses the metrics boundary and opaque cursor on later pages", async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce({ rows: [row({ id: "a" })], nextCursor: "opaque-cursor-2" });
    list.mockResolvedValueOnce({
      rows: [row({ id: "b", username: "mo" })],
      nextCursor: null,
    });

    renderList();
    await user.click(await screen.findByRole("button", { name: /Load more/i }));

    await waitFor(() => {
      const query = list.mock.calls.at(-1)![0] as string;
      const params = new URLSearchParams(query);
      expect(params.get("cursor")).toBe("opaque-cursor-2");
      expect(params.get("from")).toBe("2026-07-18");
      expect(params.get("to")).toBe("2026-08-16");
      expect(params.get("asOf")).toBe("2026-08-17T03:00:00.000Z");
    });
  });

  it("includes the metrics boundary on the first page", async () => {
    renderList();

    await waitFor(() => expect(list).toHaveBeenCalled());
    const query = list.mock.calls[0]![0] as string;
    expect(new URLSearchParams(query).get("asOf")).toBe("2026-08-17T03:00:00.000Z");
  });

  // The banner must reassure, not alarm: nothing is lost while the circuit is open.
  it("explains a paused circuit without leaking provider detail", async () => {
    metrics.mockResolvedValue({
      health: { circuitOpen: true, reason: "auth_or_permission", dueCount: 12 },
    });
    renderList();

    expect(await screen.findByText(CIRCUIT_PAUSED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/auth_or_permission/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it("hides the banner when the circuit is closed", async () => {
    renderList();
    await screen.findByText("2 people · 3 journeys");
    expect(screen.queryByText(CIRCUIT_PAUSED_MESSAGE)).not.toBeInTheDocument();
  });

  it("copes with a person and post we never resolved", async () => {
    list.mockResolvedValue({
      rows: [row({ username: null, name: null, media: { id: null, permalink: null, caption: null } })],
      nextCursor: null,
    });
    renderList();
    expect(await screen.findByText("ig-1")).toBeInTheDocument();
  });

  // The experiment is measured in people and the queue is worked in journeys.
  // A tab showing one number cannot say which it means.
  it("carries both people and journeys on every status tab", async () => {
    renderList();

    expect(
      await screen.findByRole("button", { name: "Scheduled: 6 people, 6 journeys" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Due: 2 people, 3 journeys" })).toBeInTheDocument();
  });

  describe("filters", () => {
    it("narrows the query by keyword and user-facing timing", async () => {
      renderList();
      // The select renders before its options arrive, so waiting for the
      // combobox alone races the keyword fetch.
      await screen.findByRole("option", { name: "CALM" });

      await userEvent.selectOptions(screen.getByRole("combobox", { name: /keyword/i }), "kw-2");
      await waitFor(() => expect(list).toHaveBeenCalledWith(expect.stringContaining("keywordId=kw-2")));

      await userEvent.selectOptions(screen.getByRole("combobox", { name: /timing/i }), "two_hour");
      await waitFor(() => expect(list).toHaveBeenCalledWith(expect.stringContaining("timingArm=two_hour")));
      await waitFor(() => expect(counts).toHaveBeenLastCalledWith(expect.stringContaining("timingArm=two_hour")));
    });

    // A filtered result under the previous filter's badge is the same lie as the
    // wrong tab's rows, so the filters have to be part of the cache key.
    it("does not show the unfiltered rows under a filter", async () => {
      list.mockReset();
      list.mockResolvedValueOnce({ rows: [row({ id: "unfiltered", username: "before" })], nextCursor: null });
      list.mockResolvedValue({ rows: [row({ id: "filtered", username: "after" })], nextCursor: null });

      renderList();
      await screen.findByText("@before");

      await userEvent.selectOptions(screen.getByRole("combobox", { name: /timing/i }), "no_reminder");

      expect(await screen.findByText("@after")).toBeInTheDocument();
      expect(screen.queryByText("@before")).not.toBeInTheDocument();
    });
  });

  // The cohort split costs real reminders that are deliberately withheld. If the
  // comparison is never displayed, that cost buys nothing.
  it("renders the experiment comparison, not just the health banner", async () => {
    metrics.mockResolvedValue({ ...METRICS, timingExperiment: null });
    renderList();

    expect(await screen.findByText(/treatment 48h/i)).toBeInTheDocument();
    expect(screen.getByText(/control 48h/i)).toBeInTheDocument();
    expect(screen.getByText(/lift/i)).toBeInTheDocument();
  });

  // A rate nobody has enough data for is not a rate of zero, and an experiment
  // readout that rounds the difference away is worse than no readout.
  it("shows an absent rate as absent rather than as zero", async () => {
    metrics.mockResolvedValue({
      ...METRICS,
      timingExperiment: null,
      experiment: {
        ...METRICS.experiment,
        treatment: { ...METRICS.experiment.treatment, completionRate48h: null },
        absoluteLiftPercentagePoints: null,
      },
    });
    renderList();

    await screen.findByText(/treatment 48h/i);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says the original post is unavailable rather than dropping the link", async () => {
    list.mockResolvedValue({
      rows: [row({ media: { id: null, permalink: null, caption: null } })],
      nextCursor: null,
    });
    renderList();

    expect(await screen.findByText(/original post unavailable/i)).toBeInTheDocument();
  });

  it("shows a v2 row's timing label instead of cohort jargon", async () => {
    list.mockResolvedValue({
      rows: [
        row({
          experimentVersion: "read-recovery-timing-v2",
          timingArm: "two_hour",
          timingLabel: "2-hour reminder",
        }),
      ],
      nextCursor: null,
    });
    renderList();

    const rowButton = await screen.findByRole("button", { name: /@sarah/ });
    expect(within(rowButton).getByText("2-hour reminder")).toBeInTheDocument();
    expect(screen.queryByText(/^Treatment$/)).not.toBeInTheDocument();
  });
});
