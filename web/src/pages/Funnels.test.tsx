// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => api(...a),
}));

const { Funnels } = await import("./Funnels");

function rate(numerator: number, denominator: number, pct: number | null) {
  return { numerator, denominator, pct, belowMinSample: pct === null };
}

const COVER_RATES = {
  gate: {
    accepted: rate(17, 20, 85),
    failed: rate(2, 20, 10),
    uncertain: rate(1, 20, 5),
  },
  delivery: {
    included: rate(20, 100, 20),
    duplicateSuppressed: rate(4, 100, 4),
    mispaired: rate(0, 100, 0),
  },
};

const EMPTY_COVER_RATES = {
  gate: {
    accepted: rate(0, 0, null),
    failed: rate(0, 0, null),
    uncertain: rate(0, 0, null),
  },
  delivery: {
    included: rate(0, 0, null),
    duplicateSuppressed: rate(0, 0, null),
    mispaired: rate(0, 0, null),
  },
};

const FUNNEL = {
  key: "guide-follow",
  label: "Guide → follow",
  window: { from: "2026-07-24", to: "2026-08-23" },
  cohortSize: 270,
  headline: {
    label: "Answered the unlock DM",
    rate: rate(202, 270, 74.8),
    rationale: "The gate is not the bottleneck.",
  },
  followGateConversion: rate(30, 60, 50),
  stuckAtWall: 30,
  expressLane: 40,
  byEntryPath: [],
  stages: [],
  retention: rate(11, 12, null),
};

const DROP_OFF = {
  bucket: "no-reply",
  label: "No reply",
  definition: "Never replied to the unlock DM.",
  total: 0,
  byState: { expired: 0, stillOpen: 0 },
  readEvidence: {
    confirmedSeen: 0,
    trackedNeverConfirmed: 0,
    noReadData: 0,
    confirmedSeenOfTracked: rate(0, 0, null),
  },
  recovery: { reminderSent: 0, reminderSuppressed: 0, inControlArm: 0, noReminder: 0 },
  rows: [],
};

function respond(overrides: { cover?: unknown } = {}) {
  api.mockImplementation((path: string) => {
    if (path.startsWith("/funnels/guide-access-metrics")) {
      return Promise.resolve(
        overrides.cover ?? { key: "guide-access-v2", window: FUNNEL.window, coverRates: COVER_RATES },
      );
    }
    // The link funnel has its own panel; these tests leave it loading.
    if (path.startsWith("/funnels/link-click")) return new Promise(() => {});
    if (path.includes("/drop-off/")) return Promise.resolve(DROP_OFF);
    return Promise.resolve(FUNNEL);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Funnels />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  api.mockReset();
});

describe("Funnels cover panel", () => {
  it("shows the cover shares the API computed", async () => {
    respond();
    renderPage();

    await waitFor(() => expect(screen.getByText(/guide cover/i)).toBeInTheDocument());
    // Rendered, not recomputed. The page must not do its own arithmetic.
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("reads as not started rather than as zero when no cover has been considered", async () => {
    respond({
      cover: {
        key: "guide-access-v2",
        window: FUNNEL.window,
        coverRates: EMPTY_COVER_RATES,
      },
    });
    renderPage();

    // The rollout is off by default, so an empty panel is the NORMAL state. Showing "0%"
    // would read as a feature that is failing rather than one that has not started.
    await waitFor(() =>
      expect(screen.getByText(/no cover has been considered yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("reads as switched off when every cover decision in the window came back not selected", async () => {
    // Production on 2026-10-12: 492 delivery decisions, all `omitted_not_selected`, because
    // the rollout fence selects nobody. The panel printed "0% — 0 of 492", which reads as a
    // cover that fails to send rather than a rollout that has not started.
    respond({
      cover: {
        key: "guide-access-v2",
        window: FUNNEL.window,
        coverRates: {
          ...EMPTY_COVER_RATES,
          delivery: {
            included: rate(0, 492, 0),
            duplicateSuppressed: rate(0, 492, 0),
            mispaired: rate(0, 492, 0),
          },
        },
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/the cover rollout is not selecting anyone/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/all 492 deliveries/i)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("calls out a mispaired cover instead of leaving it as one share among six", async () => {
    respond({
      cover: {
        key: "guide-access-v2",
        window: FUNNEL.window,
        coverRates: {
          ...COVER_RATES,
          delivery: { ...COVER_RATES.delivery, mispaired: rate(3, 100, 3) },
        },
      },
    });
    renderPage();

    // A cover paired with the wrong guide is a data fault, not a rollout outcome. It has to
    // be louder than the row it would otherwise occupy.
    await waitFor(() =>
      expect(screen.getByText(/belonged to a different guide/i)).toBeInTheDocument(),
    );
  });

  it("keeps the follow funnel readable when the cover panel fails on its own", async () => {
    api.mockImplementation((path: string) => {
      if (path.startsWith("/funnels/guide-access-metrics")) {
        return Promise.reject(new Error("metrics query timed out"));
      }
      if (path.startsWith("/funnels/link-click")) return new Promise(() => {});
      if (path.includes("/drop-off/")) return Promise.resolve(DROP_OFF);
      return Promise.resolve(FUNNEL);
    });
    renderPage();

    // The cover panel is secondary. Its failure must not take the page's main funnel down.
    await waitFor(() => expect(screen.getByText("74.8%")).toBeInTheDocument());
    expect(screen.getByText(/cover numbers could not be loaded/i)).toBeInTheDocument();
  });

  it("reports gate exposure separately from delivery inclusion", async () => {
    // The two are different populations. Rendering them as one group is what let a share of
    // gate exposures be divided by a count of delivery-plan selections.
    respond();
    renderPage();

    await waitFor(() => expect(screen.getByText(/in the follow gate/i)).toBeInTheDocument());
    expect(screen.getByText(/in the guide delivery/i)).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("says the numbers are unavailable when the API does not serve them yet", async () => {
    // The web bundle deploys before the API here, so a 200 without `coverRates` is the
    // normal ordering. react-query will not retry a success, so a skeleton would sit
    // forever and claim to still be loading.
    respond({ cover: { key: "guide-access-v2", window: FUNNEL.window } });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/does not report cover numbers yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/no cover has been considered yet/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot=\"skeleton\"]")).toHaveLength(0);
  });

  it("never asks the API for a parent identifier alongside the cover shares", async () => {
    respond();
    renderPage();

    await waitFor(() => expect(screen.getByText(/guide cover/i)).toBeInTheDocument());
    const coverCalls = api.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith("/funnels/guide-access-metrics"));
    expect(coverCalls).toHaveLength(1);
    // Aggregate-only by construction: a cohort window and nothing else.
    expect(coverCalls[0]).toMatch(/^\/funnels\/guide-access-metrics\?from=[\d-]+&to=[\d-]+$/);
  });

  it("asks for a window that includes today", async () => {
    // `to` is exclusive midnight UTC on the API, so sending today's date dropped every
    // conversation since 00:00 UTC — including the only link guide asked for that day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T02:30:00.000Z"));
    try {
      respond();
      renderPage();

      await waitFor(() => expect(api).toHaveBeenCalled());
      const paths = api.mock.calls.map(([path]) => String(path));
      expect(paths).toContain("/funnels/guide-follow?from=2026-09-14&to=2026-10-14");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a creator warning when live guide requests need review", async () => {
    respond({
      cover: {
        key: "guide-access-v2",
        window: FUNNEL.window,
        coverRates: COVER_RATES,
        health: {
          awaitingRequest: 2,
          awaitingFollow: 4,
          needsReview: 6,
          logicallyExpiredActiveTokens: 3,
          oldestNeedsReviewAt: "2026-08-20T10:00:00.000Z",
        },
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/6 guide requests need owner review/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /review conversations/i })).toHaveAttribute(
      "href",
      "/conversations",
    );
  });

  it("does not raise the warning for expired actions nobody can act on", async () => {
    // Tokens expire lazily and nothing sweeps their status, so this count is every
    // unanswered opening ever sent (12,133 on 2026-10-12). As a warning it never cleared.
    respond({
      cover: {
        key: "guide-access-v2",
        window: FUNNEL.window,
        coverRates: COVER_RATES,
        health: {
          awaitingRequest: 2,
          awaitingFollow: 4,
          needsReview: 0,
          logicallyExpiredActiveTokens: 12133,
          oldestNeedsReviewAt: null,
        },
      },
    });
    renderPage();

    await waitFor(() => expect(screen.getByText(/guide cover/i)).toBeInTheDocument());
    expect(screen.queryByText(/need attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/12,133/)).not.toBeInTheDocument();
  });
});

describe("Funnels 21-day reading", () => {
  function stage(key: string, count: number, ofPrevPct: number | null) {
    return { key, label: key, definition: key, count, ofEntryPct: null, ofPrevPct, coverageOnly: true };
  }

  it("measures the worker against the converts owed a reading, not everyone following", async () => {
    // The page read "re-measured 0 of 3,942 eligible": 3,942 was everyone following after
    // delivery. Most were already following before they asked and never get the reading.
    api.mockImplementation((path: string) => {
      if (path.startsWith("/funnels/guide-access-metrics")) return new Promise(() => {});
      if (path.startsWith("/funnels/link-click")) return new Promise(() => {});
      if (path.includes("/drop-off/")) return Promise.resolve(DROP_OFF);
      return Promise.resolve({
        ...FUNNEL,
        stages: [stage("followingMeasured", 3942, 93.9), stage("followingD21", 0, 0)],
        retention: rate(0, 0, null),
        followThroughDue: 454,
      });
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/only people who had to follow/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/read 0 of the 454/i)).toBeInTheDocument();
    expect(screen.queryByText(/3,942 eligible/i)).not.toBeInTheDocument();
  });
});
