// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recoveryList = vi.fn();
const recoveryCounts = vi.fn();
const recoveryMetrics = vi.fn();
const settingsVerifications = vi.fn();
const activateSettingsVerification = vi.fn();
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
    settingsVerifications: () => settingsVerifications(),
    activateSettingsVerification: (id: string) => activateSettingsVerification(id),
  },
}));

const { DmRecovery } = await import("./DmRecovery");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DmRecovery />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
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
  settingsVerifications.mockReset().mockResolvedValue({ records: [] });
  activateSettingsVerification.mockReset().mockResolvedValue(undefined);
});

describe("DM recovery page", () => {
  // Carried over from Conversations.test.tsx, where this ran behind a lens click.
  // The assertions are the same because the surface is the same; only its address
  // changed, and coverage should not have been lost in the move.
  it("shows the recovery views on arrival, no lens click needed", async () => {
    renderPage();

    expect(await screen.findByRole("button", { name: /Due/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Attention/ })).toBeInTheDocument();
    // The summary describes the tab in view, and Due is the default. The
    // grand total is still one click away under the All tab.
    expect(await screen.findByText("2 people · 3 journeys")).toBeInTheDocument();
  });

  it("names itself, since the rail label is no longer the only thing identifying it", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "DM recovery" })).toBeInTheDocument();
  });

  // The page exists to keep a public-posting system off a row of reading
  // controls. Its operating model must be explicit before someone relies on it.
  it("states that the reminder is an automatic public comment", () => {
    renderPage();
    const explanation = screen.getByText(/Tiny Soho may automatically post one public reminder/i);
    expect(explanation).toHaveTextContent(/original Instagram comment/i);
    expect(explanation).toHaveTextContent(/cancel before the worker claims it/i);
    expect(explanation).not.toHaveTextContent(/nothing here sends on its own/i);
    expect(explanation).not.toHaveTextContent(/released/i);
  });

  it("does not fetch the conversation journeys it no longer shares a page with", async () => {
    renderPage();
    await screen.findByRole("button", { name: /Due/ });

    const paths = api.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith("/conversations"))).toBe(false);
  });
});
