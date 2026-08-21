// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "@/lib/types";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { Switches } = await import("./Switches");

function flag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "AI_DRAFTS_ENABLED",
    name: "Reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat: "Writes a suggested reply for each conversation waiting on you.",
    affectsWho: "Only you.",
    ifOff: "Suggestions stop appearing.",
    pageMayEnable: true,
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Switches />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
// Block body, deliberately. `mockReset()` returns the mock for chaining, and an
// arrow that returns it hands vitest that function as a teardown callback — which
// vitest then CALLS after every test, invoking apiRead() with no arguments. Against
// a rejecting mock that surfaces as an unhandled "Error: down" attributed to
// whichever test ran last.
beforeEach(() => {
  apiRead.mockReset();
});

describe("Switches list", () => {
  // The whole reason for this rewrite. Sixteen rows of three sentences was
  // unreadable; a list is for finding the thing, not deciding about it.
  it("shows no descriptions and no controls", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByRole("link", { name: /Reply drafts/ })).toBeInTheDocument();
    expect(screen.queryByText(/Writes a suggested reply/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Who it affects/)).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("links each row to its own page", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByRole("link", { name: /Reply drafts/ })).toHaveAttribute(
      "href",
      "/switches/AI_DRAFTS_ENABLED",
    );
  });

  it("keeps the blast-radius grouping, loudest first", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag(),
        flag({ key: "DM_RECOVERY_ENABLED", name: "Recovery reminders", group: "outbound" }),
      ],
    });
    renderPage();

    const outbound = await screen.findByText("Reaches real people");
    const assistive = screen.getByText("Nothing leaves the app");
    expect(
      outbound.compareDocumentPosition(assistive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Five of these move together and nothing used to say so.
  it("says which experiment a switch belongs to, using the served name", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag({
          key: "DM_RECOVERY_ENABLED",
          name: "Recovery reminders",
          group: "outbound",
          experimentKey: "recovery-reminder-timing-v2",
          experimentName: "Recovery reminder — 2 vs 6 hours",
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("part of Recovery reminder — 2 vs 6 hours")).toBeInTheDocument();
  });

  it("says nothing about experiments for a standalone switch", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByRole("link", { name: /Reply drafts/ })).toBeInTheDocument();
    expect(screen.queryByText(/part of/i)).not.toBeInTheDocument();
  });

  it("shows a percentage switch as its percentage, not as on or off", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag({
          key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
          name: "Share on the new path",
          group: "outbound",
          kind: "percent",
          valueBool: null,
          valuePercent: 0,
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText("0%")).toBeInTheDocument();
    expect(screen.queryByText("Off")).not.toBeInTheDocument();
  });

  it("calls a failed read a connection problem", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
    expect(screen.queryByText("Reaches real people")).not.toBeInTheDocument();
  });
});
