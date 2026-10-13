// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FunnelStageCount,
  GuideFollowResult,
  Stats,
} from "@/lib/types";

const responses = new Map<string, Promise<unknown> | (() => Promise<unknown>)>();
const api = vi.fn(<T,>(path: string) => {
  const response = responses.get(path);
  return (typeof response === "function" ? response() : response) as Promise<T>;
});

vi.mock("@/lib/api", () => ({
  api: <T,>(path: string) => api(path) as Promise<T>,
  // Reads take a signal now. The mock drops it so assertions stay about paths.
  apiRead: <T,>(path: string) => api(path) as Promise<T>,
}));

const { Home } = await import("./Home");

function clearStats(): Stats {
  return {
    activeKeywords: 8,
    totalKeywords: 8,
    dmsSentToday: 12,
    conversationsAwaiting: 0,
    completedToday: 9,
    lastError: null,
    gateQueuePending: 0,
    gateQueueExhausted: 0,
    gateQueueSendUncertain: 0,
  };
}

function stage(key: string, label: string, count: number): FunnelStageCount {
  return {
    key,
    label,
    definition: `${label} definition`,
    count,
    ofEntryPct: null,
    ofPrevPct: null,
  };
}

function clearFunnel(): GuideFollowResult {
  return {
    key: "guide-follow",
    name: "Guide → follow",
    question: "Where do followers stop?",
    window: { from: "2026-07-17T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" },
    cohortSize: 100,
    stages: [stage("entered", "Entered", 100), stage("delivered", "Delivered", 100)],
    headline: {
      fromStage: "entered",
      toStage: "delivered",
      label: "Delivery rate",
      rationale: "",
      rate: { numerator: 100, denominator: 100, pct: 100, belowMinSample: false },
    },
    followGateConversion: {
      numerator: 100,
      denominator: 100,
      pct: 100,
      belowMinSample: false,
    },
    stuckAtWall: 0,
    askDistribution: [],
    expressLane: 0,
    byEntryPath: [],
    retention: { numerator: 5, denominator: 5, pct: 100, belowMinSample: false },
    homeTileCohort: { deliveredToNonFollower: 0, ofWhichRedelivery: 0 },
  };
}

function pending(): Promise<never> {
  return new Promise(() => undefined);
}

function renderHome(input?: {
  stats?: Promise<Stats>;
  funnel?: Promise<GuideFollowResult>;
}) {
  responses.set("/insights/follower-daily-adds", pending());
  responses.set("/stats", input?.stats ?? pending());
  responses.set("/funnels/guide-journey", input?.funnel ?? pending());
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  responses.clear();
  api.mockClear();
});

afterEach(cleanup);

describe("Home evidence readiness", () => {
  it("never renders reassurance while required requests are pending", () => {
    renderHome();
    expect(screen.getByText(/Checking what needs attention/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is waiting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing is failing/)).not.toBeInTheDocument();
  });

  it("shows incomplete when stats fail even if the funnel succeeds", async () => {
    renderHome({
      stats: Promise.reject(new Error("stats unavailable")),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
    expect(screen.queryByText(/automation is running without you/i)).not.toBeInTheDocument();
  });

  it("shows all clear only after every required source succeeds", async () => {
    renderHome({
      stats: Promise.resolve(clearStats()),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/Nothing is waiting on you today/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is failing and nothing is queued/)).toBeInTheDocument();
  });

  it("keeps verified failed-gate attention visible and retries only funnel evidence", async () => {
    const user = userEvent.setup();
    renderHome({
      stats: Promise.resolve({ ...clearStats(), gateQueueExhausted: 3 }),
      funnel: Promise.reject(new Error("funnel unavailable")),
    });
    expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
    expect(screen.getAllByText("3 gate deliveries gave up")).toHaveLength(2);
    const retry = screen.getByRole("button", { name: /Retry funnel evidence/ });
    const funnelCallsBeforeRetry = api.mock.calls.filter(
      ([path]) => path === "/funnels/guide-journey",
    ).length;
    await user.click(retry);
    await waitFor(() =>
      expect(
        api.mock.calls.filter(([path]) => path === "/funnels/guide-journey").length,
      ).toBe(funnelCallsBeforeRetry + 1),
    );
    expect(
      api.mock.calls.filter(([path]) => path === "/insights/follower-daily-adds"),
    ).toHaveLength(0);
  });

  it("needs no follower data and never requests attribution", async () => {
    renderHome({ stats: Promise.resolve(clearStats()), funnel: Promise.resolve(clearFunnel()) });
    expect(await screen.findByText(/Nothing is waiting on you today/)).toBeInTheDocument();
    expect(api.mock.calls.map(([path]) => path).sort()).toEqual(["/funnels/guide-journey", "/stats"]);
    expect(screen.queryByText("Total followers")).not.toBeInTheDocument();
    expect(screen.queryByText("US followers this week")).not.toBeInTheDocument();
    expect(screen.queryByText(/Where are your followers coming from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Today.s read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
    expect(screen.getByText("System pulse")).toBeInTheDocument();
    expect(screen.getByText("Delivery rate")).toBeInTheDocument();
  });

  it("keeps funnel attention visible when stats fail and retries only stats", async () => {
    const user = userEvent.setup();
    const funnel = clearFunnel();
    funnel.stages = [stage("gateSent", "Gate sent", 100), stage("replied", "Replied", 60)];
    renderHome({ stats: Promise.reject(new Error("offline")), funnel: Promise.resolve(funnel) });
    expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
    expect(screen.getAllByText(/40 of 100 conversations stop here/)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Retry system stats" }));
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/stats")).toHaveLength(2));
    expect(api.mock.calls.filter(([path]) => path === "/funnels/guide-journey")).toHaveLength(1);
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });
});
