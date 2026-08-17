// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FollowerDailyAddsPoint,
  FollowerFlowResponse,
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
}));

vi.mock("@/components/home/FollowerFlowPanel", () => ({
  FollowerFlowPanel: ({
    onDaySelect,
  }: {
    onDaySelect: (day: string) => void;
  }) => <button onClick={() => onDaySelect("2026-08-14")}>Inspect Aug 14 attribution</button>,
}));

vi.mock("@/components/home/FeedFollowAttributionDrawer", () => ({
  FeedFollowAttributionDrawer: () => null,
}));

vi.mock("@/components/home/FollowerKpiRow", () => ({
  FollowerKpiRow: () => null,
}));

const { Home } = await import("./Home");

function point(day: string, us: number): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total: us,
    unattributed: 0,
    reportedTotalDelta: us,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
  };
}

function settledFlow(): FollowerFlowResponse {
  return {
    analyticsTimeZone: "America/Los_Angeles",
    points: Array.from({ length: 14 }, (_, index) =>
      point(`2026-08-${String(index + 1).padStart(2, "0")}`, index < 7 ? 10 : 20),
    ),
    stock: {
      capturedAt: "2026-08-14T23:00:00.000Z",
      totalCounted: 4355,
      followersTotal: 4578,
      us: 1489,
      southAsian: 1278,
      anglosphere: 817,
      other: 771,
      countriesReported: 45,
    },
  };
}

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
  flow?: Promise<FollowerFlowResponse>;
  stats?: Promise<Stats>;
  funnel?: Promise<GuideFollowResult>;
}) {
  responses.set("/insights/follower-daily-adds", input?.flow ?? pending());
  responses.set("/stats", input?.stats ?? pending());
  responses.set("/funnels/guide-follow", input?.funnel ?? pending());
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

  it("shows incomplete when stats fail even if the follower read succeeds", async () => {
    renderHome({
      flow: Promise.resolve(settledFlow()),
      stats: Promise.reject(new Error("stats unavailable")),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
    expect(screen.queryByText(/automation is running without you/i)).not.toBeInTheDocument();
  });

  it("shows all clear only after every required source succeeds", async () => {
    renderHome({
      flow: Promise.resolve(settledFlow()),
      stats: Promise.resolve(clearStats()),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/Nothing is waiting on you today/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is failing and nothing is queued/)).toBeInTheDocument();
  });

  it("keeps verified failed-gate attention visible and retries only funnel evidence", async () => {
    const user = userEvent.setup();
    renderHome({
      flow: Promise.resolve(settledFlow()),
      stats: Promise.resolve({ ...clearStats(), gateQueueExhausted: 3 }),
      funnel: Promise.reject(new Error("funnel unavailable")),
    });
    expect(await screen.findByText(/The check is incomplete/)).toBeInTheDocument();
    expect(screen.getAllByText("3 gate deliveries gave up")).toHaveLength(2);
    const retry = screen.getByRole("button", { name: /Retry funnel evidence/ });
    const funnelCallsBeforeRetry = api.mock.calls.filter(
      ([path]) => path === "/funnels/guide-follow",
    ).length;
    await user.click(retry);
    await waitFor(() =>
      expect(
        api.mock.calls.filter(([path]) => path === "/funnels/guide-follow").length,
      ).toBe(funnelCallsBeforeRetry + 1),
    );
    expect(
      api.mock.calls.filter(([path]) => path === "/insights/follower-daily-adds"),
    ).toHaveLength(1);
  });

  it("keeps the follower read when optional attribution detail fails", async () => {
    const user = userEvent.setup();
    responses.set(
      "/insights/feed-follow-attribution?from=2026-08-14&to=2026-08-14",
      () => Promise.reject(new Error("attribution unavailable")),
    );
    renderHome({
      flow: Promise.resolve(settledFlow()),
      stats: Promise.resolve(clearStats()),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/US follower growth is 100% faster/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inspect Aug 14 attribution" }));
    expect(screen.getByText(/US follower growth is 100% faster/)).toBeInTheDocument();
    expect(screen.queryByText(/The check is incomplete/)).not.toBeInTheDocument();
  });

  it("explains why a provisional window cannot be interpreted", async () => {
    const flow = settledFlow();
    flow.points.at(-1)!.provisional = true;
    renderHome({
      flow: Promise.resolve(flow),
      stats: Promise.resolve(clearStats()),
      funnel: Promise.resolve(clearFunnel()),
    });
    expect(await screen.findByText(/Newest measurements are still settling/)).toBeInTheDocument();
    expect(screen.queryByText(/US follower growth is/)).not.toBeInTheDocument();
  });
});
