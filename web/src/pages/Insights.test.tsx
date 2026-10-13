// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LeaderboardRow, ReelInsightDetail, RecipeData, Experiment } from "@/lib/types";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const apiMutation = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Insights } = await import("./Insights");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Insights />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMutation.mockReset();
  // The page reads several endpoints; an empty envelope satisfies all of them.
  api.mockReset().mockResolvedValue({ items: [], points: [], stages: [] });
});

afterEach(cleanup);

/**
 * An experiment's baseline is measured at creation, which makes a duplicate
 * expensive: two rows would each claim to be measuring the same change from a
 * different starting point. The client UUID is what stops that.
 */
describe("Insights experiment create identity", () => {
  async function openExperimentForm() {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Experiments" }));
    await user.click(await screen.findByRole("button", { name: /New experiment/ }));

    fireEvent.change(screen.getByLabelText("Hypothesis"), {
      target: { value: "Trending US audio lifts reach" },
    });
    fireEvent.change(screen.getByLabelText(/the variable/i), {
      target: { value: "trending US audio" },
    });
    return user;
  }

  function lastCreateCall() {
    return apiMutation.mock.calls
      .filter(([p]) => String(p) === "/insights/experiments")
      .at(-1)?.[1] as { operationId?: string; body?: string } | undefined;
  }

  it("sends one UUID as both the experiment id and the idempotency key", async () => {
    apiMutation.mockResolvedValue({ id: "exp-1" });
    const user = await openExperimentForm();

    await user.click(screen.getByRole("button", { name: "Start experiment" }));

    await waitFor(() => expect(lastCreateCall()).toBeDefined());
    const options = lastCreateCall()!;
    const body = JSON.parse(String(options.body));
    expect(body.id).toBe(options.operationId);
    expect(body.hypothesis).toBe("Trending US audio lifts reach");
  });

  it("repeats the same UUID after an unknown outcome", async () => {
    apiMutation.mockRejectedValueOnce(new Error("unknown outcome"));
    const user = await openExperimentForm();

    const start = screen.getByRole("button", { name: "Start experiment" });
    await user.click(start);
    await waitFor(() => expect(lastCreateCall()).toBeDefined());
    const first = lastCreateCall()!.operationId;

    apiMutation.mockResolvedValue({ id: "exp-1" });
    await user.click(start);
    await waitFor(() =>
      expect(
        apiMutation.mock.calls.filter(([p]) => String(p) === "/insights/experiments").length,
      ).toBe(2),
    );

    // A fresh UUID here would have created a second experiment measuring the same
    // change from a second baseline.
    expect(lastCreateCall()!.operationId).toBe(first);
  });
});

const reel: LeaderboardRow = {
  mediaId: "synthetic-reel", caption: "Synthetic breakfast reel", thumbnailUrl: null,
  permalink: "https://www.instagram.com/reel/synthetic/", postedAt: "2026-09-18T12:00:00Z",
  usFitScore: 82, confidence: "high", mediaAudioType: "original", videoUnavailable: false,
  analyzed: true, views: 98123, reach: 54321, skipRate: 0.25,
  conversion: { keywordComments: 200, gateDelivered: 180, completed: 160 }, captureRatePct: 0.37,
};
const detail: ReelInsightDetail = {
  ...reel, manualAudioType: null, manualLangOverride: null, manualNote: null,
  contentProfile: {
    transcript: "Breakfast", onScreenText: "Waffles", onScreenLang: "en", speakerAccent: "US",
    accentConfidence: 0.9, visualSetting: "home kitchen", culturalReferences: [{ text: "waffles", region: "US" }],
    hookArchetype: "problem_solution", audioVibe: "calm", usCulturalFitRationale: "Everyday breakfast in a US home.",
    accentScore: 80, settingScore: 85, culturalScore: 82,
    source: "video", promptVersion: "v1", modelId: "synthetic", costUsd: 0,
  },
  latestPerf: { views: 98123, reach: 54321, likes: 600, comments: 200, shares: 150, saved: 100,
    totalInteractions: 1050, avgWatchTimeMs: 3000, skipRate: 0.25, capturedAt: "2026-09-19T12:00:00Z" },
};
const group = { reels: [reel], usRefs: [{ text: "waffles", count: 2 }], indiaRefs: [],
  avgUsFit: 82, avgSettingScore: 85, avgCulturalScore: 82, medianReach: 54321 };
const recipe: RecipeData = { ready: true, scoredCount: 10,
  top: { ...group, label: "US-aimed" }, bottom: { ...group, label: "Other tone" },
  checklist: ["Show everyday breakfast routines"], usFitReachCorr: 0.123 };
const experiment: Experiment = {
  id: "synthetic-exp", hypothesis: "One content change", variable: "audio", reelMediaIds: [],
  status: "running", baselineUsPct: 35, measuredUsPct: 40, currentUsPct: 40,
  startedAt: "2026-09-18T12:00:00Z", postedAt: null, conclusion: null,
  origin: "manual", mediaId: null, usFitScore: null, culturalCues: [],
  baselineEngagedUsPct: null, measuredEngagedUsPct: null, windowReachShare: null,
  suggestedVerdict: null, attributionConfidence: null, hookArchetype: null, audioVibe: null, onScreenLang: null,
};
function populatedReads() {
  api.mockImplementation(async (path: string) => {
    if (path === "/insights/leaderboard") return { items: [reel] };
    if (path === "/insights/reels/synthetic-reel") return detail;
    if (path === "/insights/recipe") return recipe;
    if (path === "/insights/experiments") return { items: [experiment] };
    if (path === "/insights/reel-origin") return { items: [{ mediaId: reel.mediaId, caption: "Synthetic commenters",
      usFitScore: 82, total: 10, usWestern: 6, southAsian: 2, other: 1, unknown: 1, followers: 4 }] };
    return { items: [], points: [], stages: [{ stage: "follower", usPct: 43, inPct: 12 }] };
  });
}

describe("Insights reporting removal", () => {
  it("keeps AI and conversion detail while removing populated performance metrics", async () => {
    populatedReads();
    apiMutation.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Synthetic breakfast reel/ }));
    expect(await screen.findByText("What it converted")).toBeInTheDocument();
    expect(screen.getByText("Everyday breakfast in a US home.")).toBeInTheDocument();
    expect(screen.getByText("keyword comments")).toBeInTheDocument();
    expect(screen.getByText("guides delivered")).toBeInTheDocument();
    expect(screen.queryByText("How it performed")).not.toBeInTheDocument();
    expect(screen.queryByText("Which reels should I repeat?")).not.toBeInTheDocument();
    expect(screen.queryByText("54,321 reach")).not.toBeInTheDocument();
    expect(screen.queryByText("0.37% capture")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-analyze" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledWith("/insights/reels/synthetic-reel/analyze", { method: "POST" }));
  });

  it("keeps Recipe and commenter-origin evidence without reach statistics", async () => {
    populatedReads();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Recipe" }));
    expect(await screen.findByText("Show everyday breakfast routines")).toBeInTheDocument();
    expect(await screen.findByText("Synthetic commenters")).toBeInTheDocument();
    expect(screen.getByText(/proxy, not real geography/)).toBeInTheDocument();
    expect(screen.queryAllByText("Median reach")).toHaveLength(0);
    expect(screen.queryByText(/r = 0.123/)).not.toBeInTheDocument();
  });

  it("does not request removed geography reports across all tabs", async () => {
    populatedReads();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Synthetic breakfast reel/ });
    await user.click(screen.getByRole("button", { name: "Recipe" }));
    await screen.findByText("Show everyday breakfast routines");
    await user.click(screen.getByRole("button", { name: "Experiments" }));
    await screen.findByText("One content change");
    expect(api.mock.calls.some(([path]) => ["/insights/geo", "/insights/us-reach-trend", "/insights/geo-window-trend"].includes(String(path)))).toBe(false);
    expect(screen.queryByText("Audience geography (account-wide)")).not.toBeInTheDocument();
    expect(screen.queryByText("Reached-US% over time")).not.toBeInTheDocument();
    expect(screen.queryByText("Which reels capture the most?")).not.toBeInTheDocument();
  });

  it("retains experiment results and updates", async () => {
    populatedReads();
    apiMutation.mockResolvedValue({ ...experiment, status: "confirmed" });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Experiments" }));
    expect(await screen.findByText("One content change")).toBeInTheDocument();
    expect(screen.getByText("35%")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("+5 pts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark confirmed" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledWith("/insights/experiments/synthetic-exp", {
      method: "PATCH", body: JSON.stringify({ status: "confirmed" }),
    }));
  });
});
