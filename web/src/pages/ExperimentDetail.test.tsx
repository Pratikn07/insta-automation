// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentDetailView, FlagView } from "@/lib/types";

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
