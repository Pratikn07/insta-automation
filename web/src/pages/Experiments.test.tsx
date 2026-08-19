// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
      name: "Recovery reminder timing",
      state: "running",
      armCount: 2,
      blocker: "",
      summary: {
        kind: "running",
        arms: [
          { key: "treatment", label: "Got a reminder", people: 1958 },
          { key: "control", label: "Got nothing", people: 394 },
        ],
        notCounted: [{ reason: "They opened it themselves", people: 531 }],
        endsAt: "2026-08-21T21:45:00.000Z",
        whenItEnds: "When the window closes, reminders stop and wait for your decision.",
      },
    },
  ],
};

describe("Experiments list", () => {
  it("shows one line each, linking to its own page", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByRole("link", { name: /Recovery reminder timing/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing",
    );
  });

  // The one number that matters, so the list answers "how is it going" by itself.
  it("gives a running experiment its arm counts and its countdown", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(
      await screen.findByText("Got a reminder 1,958 · Got nothing 394 · 3 days left"),
    ).toBeInTheDocument();
  });

  // "Not started" is the useful part: a list of experiments you could run tomorrow.
  it("says not started, with why, rather than showing zeroes", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByText("Not started")).toBeInTheDocument();
    expect(screen.getByText(/rollout is at zero/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  // The API returns registry order; the page decides what you see first.
  it("puts a running experiment above one that has not started", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    const running = await screen.findByText("Running");
    const notStarted = screen.getByText("Not started");
    expect(
      running.compareDocumentPosition(notStarted) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says a window has closed rather than counting backwards", async () => {
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByText(/already closed/)).toBeInTheDocument();
  });

  it("calls a failed read a connection problem", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
