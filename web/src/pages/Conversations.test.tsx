// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recoveryList = vi.fn();
const recoveryCounts = vi.fn();
const recoveryMetrics = vi.fn();
const api = vi.fn();

vi.mock("../lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  recoveryApi: {
    list: (...a: unknown[]) => recoveryList(...a),
    counts: () => recoveryCounts(),
    metrics: () => recoveryMetrics(),
    detail: vi.fn(),
    cancel: vi.fn(),
    markReviewed: vi.fn(),
  },
}));

const { Conversations } = await import("./Conversations");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Conversations />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  // The generic client serves several endpoints on this page, and they do not
  // share a response shape — /keywords returns a bare array, the paged endpoints
  // return an envelope. One blanket value makes whichever caller it does not fit
  // fail somewhere unrelated.
  api.mockReset().mockImplementation((path: string) =>
    Promise.resolve(String(path).startsWith("/keywords") ? [] : { items: [], nextCursor: null }),
  );
  recoveryList.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  recoveryCounts.mockReset().mockResolvedValue({
    all: { records: 21, people: 18 },
    scheduled: { records: 6, people: 6 },
    ready: { records: 3, people: 2 },
    sent: { records: 5, people: 5 },
    suppressed: { records: 4, people: 3 },
    control: { records: 2, people: 2 },
    attention: { records: 1, people: 1 },
  });
  recoveryMetrics.mockReset().mockResolvedValue({
    health: { circuitOpen: false, reason: null, dueCount: 0 },
  });
});

describe("Conversations recovery lens", () => {
  it("keeps Needs reply as the default and does not fetch recovery until asked", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Needs reply" })).toBeInTheDocument();
    expect(recoveryList).not.toHaveBeenCalled();
  });

  it("adds a DM recovery lens beside the existing ones", () => {
    renderPage();
    for (const label of ["Needs reply", "DMs", "DM recovery"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("shows the recovery views once selected", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "DM recovery" }));

    expect(await screen.findByRole("button", { name: /Ready/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Attention/ })).toBeInTheDocument();
    // The summary describes the tab in view, and Ready is the default. The
    // grand total is still one click away under the All tab.
    expect(await screen.findByText("2 people · 3 journeys")).toBeInTheDocument();
  });

  // The old label asserted the person chose not to answer. A journey can end
  // here because the gate DM never landed, which is a different fact.
  it("no longer calls an expired journey No reply", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /No confirmed reply/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^No reply/ })).not.toBeInTheDocument();
  });

  // Each lens renders one list. Fetching the others' pages costs the user data
  // and the API load for rows that are never displayed — and the journeys query
  // is paginated, so it kept fetching.
  it.each([
    ["Needs reply", "needs_reply"],
    ["DM recovery", "recovery"],
  ])("does not fetch journeys while viewing %s", async (label) => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(api).toHaveBeenCalled());

    // /conversations/counts feeds the always-visible journey filter pills and is
    // expected on every lens; the paginated list is the one that was waste.
    const paths = api.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith("/conversations?"))).toBe(false);
  });

  it("does fetch journeys once a journey filter selects that lens", async () => {
    const user = userEvent.setup();
    renderPage();

    // The journeys lens has no tab of its own — its filter pills select it.
    await user.click(screen.getByRole("button", { name: /Waiting/ }));

    await waitFor(() =>
      expect(
        api.mock.calls.map((c) => String(c[0])).some((p) => p.startsWith("/conversations?")),
      ).toBe(true),
    );
  });
});
