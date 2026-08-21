// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentsResponse } from "@/lib/types";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { Experiments } = await import("./Experiments");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Experiments />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
// Block body: an arrow returning the mock hands vitest a teardown it then calls.
beforeEach(() => {
  apiRead.mockReset();
  // The countdown is relative, so the clock is pinned — otherwise "3 days left"
  // would be right today and wrong tomorrow. `shouldAdvanceTime` is needed for
  // findBy* to resolve, which means the clock creeps forward a few milliseconds; the
  // fixture window therefore sits well inside a day rather than exactly on the
  // boundary, where that creep would floor 72h down to two days.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
});

const LIST: ExperimentsResponse = {
  experiments: [
    {
      key: "guide-delivery-rollout",
      name: "Guide delivery rollout",
      state: "not_started",
      armCount: 2,
      blocker: "The rollout is at zero, so nobody is on the newer path yet.",
      summary: {
        kind: "not_started",
        wouldCompare: "The newer path versus the older one.",
        blocker: "The rollout is at zero, so nobody is on the newer path yet.",
      },
    },
    {
      key: "recovery-reminder-timing",
      name: "Recovery reminder — 10 hours vs none",
      state: "ended",
      armCount: 2,
      blocker: "This experiment concluded when the new timing test began.",
      summary: {
        kind: "ended",
        arms: [
          { key: "treatment", label: "10 hours", people: 1958 },
          { key: "control", label: "No reminder", people: 394 },
        ],
        notCounted: [{ reason: "They opened it themselves", people: 531 }],
        endedAt: "2026-08-21T16:00:00.000Z",
        conclusion: "This experiment concluded and was replaced by the 2 vs 6 hour test.",
      },
    },
    {
      key: "recovery-reminder-timing-v2",
      name: "Recovery reminder — 2 vs 6 hours",
      state: "running",
      armCount: 3,
      blocker: "",
      summary: {
        kind: "running",
        arms: [
          { key: "two_hour", label: "2 hours", people: 706 },
          { key: "six_hour", label: "6 hours", people: 701 },
          { key: "no_reminder", label: "No reminder", people: 157 },
        ],
        notCounted: [],
        endsAt: "2026-10-02T16:00:00.000Z",
        whenItEnds: "When the window closes, reminders stop and wait for your decision.",
      },
    },
    {
      key: "cold-message-test",
      name: "Cold message test",
      state: "not_started",
      armCount: 2,
      blocker: "It has never been switched on, so no message has been tried.",
      summary: {
        kind: "not_started",
        wouldCompare: "An ordinary message versus no further message.",
        blocker: "It has never been switched on, so no message has been tried.",
      },
    },
  ],
};

describe("Experiments list", () => {
  it("defaults to Active and hides planned and concluded experiments", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByRole("link", { name: /Recovery reminder — 2 vs 6 hours/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing-v2",
    );
    expect(screen.queryByText("Guide delivery rollout")).not.toBeInTheDocument();
    expect(screen.queryByText("Cold message test")).not.toBeInTheDocument();
    expect(screen.queryByText("Recovery reminder — 10 hours vs none")).not.toBeInTheDocument();
  });

  it("shows planned and concluded experiments only in their tabs", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Planned/ }));
    expect(screen.getByText("Guide delivery rollout")).toBeInTheDocument();
    expect(screen.getByText("Cold message test")).toBeInTheDocument();
    expect(screen.queryByText("Recovery reminder — 2 vs 6 hours")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Concluded/ }));
    expect(screen.getByRole("link", { name: /Recovery reminder — 10 hours vs none/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing",
    );
    expect(screen.queryByText("Guide delivery rollout")).not.toBeInTheDocument();
  });

  // The one number that matters, so the list answers "how is it going" by itself.
  it("gives a running experiment its arm counts and its countdown", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(
      await screen.findByText("2 hours 706 · 6 hours 701 · No reminder 157 · 45 days left"),
    ).toBeInTheDocument();
  });

  // "Not started" is the useful part: a list of experiments you could run tomorrow.
  it("says not started, with why, rather than showing zeroes", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Planned/ }));
    expect(screen.getAllByText("Planned")).toHaveLength(2);
    expect(screen.getByText(/rollout is at zero/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("labels the three lifecycle tabs in owner language", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByRole("tab", { name: /Active/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Planned/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Concluded/ })).toBeInTheDocument();
  });

  it("says a window has closed rather than counting backwards", async () => {
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    apiRead.mockResolvedValue(LIST);
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Concluded/ }));
    expect(screen.getByText(/Concluded 21 Aug 2026/)).toBeInTheDocument();
  });

  it("calls a failed read a connection problem", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
