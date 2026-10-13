// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function stage(key: string, label: string, count: number, ofPrevPct: number | null) {
  return { key, label, definition: label, count, ofEntryPct: null, ofPrevPct };
}

// Numbers shaped like production for Sep 14 – Oct 13, internally consistent: every leak is
// the exact gap it explains.
const JOURNEY = {
  key: "guide-journey",
  name: "Guide journey",
  question: "Of the people who ask for a guide, how many get it?",
  window: { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
  cohortSize: 9439,
  stages: [
    stage("asked", "Asked for a guide", 9439, null),
    stage("reached", "Got the card", 9438, 100),
    stage("saidYes", "Said yes", 4834, 51.2),
  ],
  headline: {
    fromStage: "reached",
    toStage: "saidYes",
    label: "Reply rate",
    rationale: "More people stop at the unlock card than anywhere else.",
    rate: rate(4834, 9438, 51.2),
  },
  newFollowers: rate(1140, 2665, 42.8),
  gotGuide: rate(3292, 9439, 34.9),
  lanes: {
    alreadyFollowing: { people: 2169, gotGuide: rate(2109, 2169, 97.2) },
    notFollowing: { people: 2665 },
  },
  leaks: {
    neverSaidYes: {
      total: 4604,
      buckets: {
        still_has_time: 191,
        wrote_not_yes: 150,
        opened_ignored: 62,
        no_sign_opened: 754,
        cannot_tell: 3447,
      },
    },
    stuckAtWall: {
      total: 1525,
      buckets: { still_has_time: 42, said_followed: 63, never_came_back: 1420 },
    },
  },
  retention: { due: 449, rate: rate(67, 69, 97.1) },
};

const NEVER_SAID_YES = {
  leak: "never-said-yes",
  rows: [
    {
      igUserId: "1",
      username: "quiet_parent",
      lastKeyword: "WAFFLE",
      cards: 2,
      lastAskedAt: "2026-10-12T15:00:00.000Z",
      bucket: "no_sign_opened",
    },
  ],
};

const STUCK_AT_WALL = {
  leak: "stuck-at-wall",
  rows: [
    {
      igUserId: "2",
      username: "wall_parent",
      lastKeyword: "TREAT",
      cards: 1,
      lastAskedAt: "2026-10-11T09:00:00.000Z",
      bucket: "said_followed",
    },
  ],
};

function respond(overrides: { cover?: unknown } = {}) {
  api.mockImplementation((path: string) => {
    if (path.startsWith("/funnels/guide-access-metrics")) {
      return Promise.resolve(
        overrides.cover ?? { key: "guide-access-v2", window: JOURNEY.window, coverRates: COVER_RATES },
      );
    }
    // The link funnel has its own panel; these tests leave it loading.
    if (path.startsWith("/funnels/link-click")) return new Promise(() => {});
    if (path.includes("/drop-off/never-said-yes")) return Promise.resolve(NEVER_SAID_YES);
    if (path.includes("/drop-off/stuck-at-wall")) return Promise.resolve(STUCK_AT_WALL);
    return Promise.resolve(JOURNEY);
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
        window: JOURNEY.window,
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
        window: JOURNEY.window,
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
        window: JOURNEY.window,
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
      if (path.includes("/drop-off/never-said-yes")) return Promise.resolve(NEVER_SAID_YES);
      if (path.includes("/drop-off/stuck-at-wall")) return Promise.resolve(STUCK_AT_WALL);
      return Promise.resolve(JOURNEY);
    });
    renderPage();

    // The cover panel is secondary. Its failure must not take the page's main funnel down.
    const headline = await screen.findByRole("region", { name: /headline/i });
    expect(within(headline).getByText("1,140")).toBeInTheDocument();
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
    respond({ cover: { key: "guide-access-v2", window: JOURNEY.window } });
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
      expect(paths).toContain("/funnels/guide-journey?from=2026-09-14&to=2026-10-14");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a creator warning when live guide requests need review", async () => {
    respond({
      cover: {
        key: "guide-access-v2",
        window: JOURNEY.window,
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
        window: JOURNEY.window,
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

describe("Funnels guide journey", () => {
  it("leads with new followers and guides delivered, not with a reply rate", async () => {
    respond();
    renderPage();

    const headline = await screen.findByRole("region", { name: /headline/i });
    expect(within(headline).getByText("1,140")).toBeInTheDocument();
    expect(within(headline).getByText("new followers")).toBeInTheDocument();
    expect(
      within(headline).getByText(/42.8% of the 2,665 who weren't following when they said yes/),
    ).toBeInTheDocument();
    expect(within(headline).getByText("3,292")).toBeInTheDocument();
    expect(within(headline).getByText(/34.9% of the 9,439 who asked/)).toBeInTheDocument();
    // The old hero was the reply rate; it now lives in the trunk, not above it.
    expect(within(headline).queryByText(/reply rate/i)).not.toBeInTheDocument();
  });

  it("draws the trunk per person", async () => {
    respond();
    renderPage();

    const trunk = await screen.findByRole("region", { name: /the trunk/i });
    expect(within(trunk).getByText("Asked for a guide")).toBeInTheDocument();
    expect(within(trunk).getByText("9,439")).toBeInTheDocument();
    expect(within(trunk).getByText("Got the card")).toBeInTheDocument();
    expect(within(trunk).getByText("Said yes")).toBeInTheDocument();
    expect(within(trunk).getByText("4,834")).toBeInTheDocument();
  });

  it("explains every person who never said yes", async () => {
    respond();
    renderPage();

    const leak = await screen.findByRole("region", { name: /never said yes/i });
    expect(within(leak).getByText(/4,604 never said yes/)).toBeInTheDocument();
    for (const [label, count] of [
      [/still has time/i, "191"],
      [/wrote to us, but not as a yes/i, "150"],
      [/opened the card and ignored it/i, "62"],
      [/no sign they opened it/i, "754"],
      [/can't tell/i, "3,447"],
    ] as const) {
      const row = within(leak).getByText(label).closest("li")!;
      expect(within(row).getByText(count)).toBeInTheDocument();
    }
  });

  it("splits everyone who said yes into two lanes", async () => {
    respond();
    renderPage();

    const already = await screen.findByRole("region", { name: /already following/i });
    expect(within(already).getByText("2,169")).toBeInTheDocument();
    expect(within(already).getByText("2,109")).toBeInTheDocument();

    const growth = screen.getByRole("region", { name: /not following yet/i });
    expect(within(growth).getByText("2,665")).toBeInTheDocument();
    expect(within(growth).getByText("Followed and got the guide")).toBeInTheDocument();
  });

  it("explains every person stuck at the wall", async () => {
    respond();
    renderPage();

    const leak = await screen.findByRole("region", { name: /stuck at the wall/i });
    expect(within(leak).getByText(/1,525 stuck at the wall/)).toBeInTheDocument();
    for (const [label, count] of [
      [/still has time/i, "42"],
      [/said they followed, instagram says no/i, "63"],
      [/never came back/i, "1,420"],
    ] as const) {
      const row = within(leak).getByText(label).closest("li")!;
      expect(within(row).getByText(count)).toBeInTheDocument();
    }
  });

  it("reads 21-day retention over new followers who were read, with how many are due", async () => {
    respond();
    renderPage();

    await waitFor(() => expect(screen.getByText(/67 of 69 read/)).toBeInTheDocument());
    expect(screen.getByText(/69 of the 449 people due a 21-day reading/)).toBeInTheDocument();
  });

  it("names the people behind a leak when asked", async () => {
    respond();
    renderPage();

    const leak = await screen.findByRole("region", { name: /never said yes/i });
    fireEvent.click(within(leak).getByRole("button", { name: /see who/i }));
    expect(await within(leak).findByText("quiet_parent")).toBeInTheDocument();
    expect(within(leak).getByText("WAFFLE")).toBeInTheDocument();
  });
});
