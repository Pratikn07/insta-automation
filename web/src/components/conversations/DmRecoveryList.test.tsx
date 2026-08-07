// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryReminderRow } from "../../lib/types";

const list = vi.fn();
const counts = vi.fn();
const metrics = vi.fn();

vi.mock("../../lib/api", () => ({
  recoveryApi: {
    list: (...a: unknown[]) => list(...a),
    counts: () => counts(),
    metrics: () => metrics(),
  },
}));

const { DmRecoveryList, CIRCUIT_PAUSED_MESSAGE } = await import("./DmRecoveryList");

function row(overrides: Partial<RecoveryReminderRow> = {}): RecoveryReminderRow {
  return {
    id: "rec-1",
    conversationId: "convo-1",
    igUserId: "ig-1",
    username: "sarah",
    name: "Sarah",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    media: { id: "media-1", permalink: "https://instagram.com/p/x", caption: "Sleep reel" },
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    acceptedAt: "2026-08-06T00:00:00.000Z",
    eligibleAt: "2026-08-06T10:00:00.000Z",
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: "2026-08-05T23:00:00.000Z",
    ...overrides,
  };
}

const COUNTS = {
  all: { records: 21, people: 18 },
  scheduled: { records: 6, people: 6 },
  ready: { records: 3, people: 2 },
  sent: { records: 5, people: 5 },
  suppressed: { records: 4, people: 3 },
  control: { records: 2, people: 2 },
  attention: { records: 1, people: 1 },
};

const HEALTHY = { health: { circuitOpen: false, reason: null, dueCount: 3 } };

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DmRecoveryList onSelect={vi.fn()} />
    </QueryClientProvider>,
  );
}

// This project does not run vitest with `globals: true`, so Testing Library's
// automatic cleanup never registers and renders leak between tests.
afterEach(cleanup);

beforeEach(() => {
  list.mockReset().mockResolvedValue({ rows: [row()], nextCursor: null });
  counts.mockReset().mockResolvedValue(COUNTS);
  metrics.mockReset().mockResolvedValue(HEALTHY);
});

describe("DmRecoveryList", () => {
  it("shows a view tab per state with its record count", async () => {
    renderList();
    for (const label of ["Scheduled", "Ready", "Sent", "Suppressed", "Control", "Attention"]) {
      expect(await screen.findByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("summarises people and journeys separately", async () => {
    renderList();
    expect(await screen.findByText("18 people · 21 journeys")).toBeInTheDocument();
  });

  // The product's central claim. Meta exposes no unread signal, so a due row
  // reports the absence of a receipt, never the state of the message.
  it("says No confirmed read and never Unread", async () => {
    list.mockResolvedValue({ rows: [row({ eligibleAt: "2020-01-01T00:00:00.000Z" })], nextCursor: null });
    const { container } = renderList();

    expect(await screen.findByText("No confirmed read")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bUnread\b/);
  });

  it("refetches with the selected view", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole("button", { name: /Attention/ }));

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith(expect.stringContaining("view=attention"));
    });
  });

  it("renders an empty state rather than a bare table", async () => {
    list.mockResolvedValue({ rows: [], nextCursor: null });
    renderList();
    expect(await screen.findByText(/No recovery reminders/i)).toBeInTheDocument();
  });

  it("surfaces a load failure with a retry", async () => {
    list.mockRejectedValue(new Error("boom"));
    renderList();
    expect(await screen.findByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("pages with the cursor", async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce({ rows: [row({ id: "a" })], nextCursor: "cursor-2" });
    list.mockResolvedValueOnce({ rows: [row({ id: "b", username: "mo" })], nextCursor: null });

    renderList();
    await user.click(await screen.findByRole("button", { name: /Load more/i }));

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith(expect.stringContaining("cursor=cursor-2"));
    });
  });

  // The banner must reassure, not alarm: nothing is lost while the circuit is open.
  it("explains a paused circuit without leaking provider detail", async () => {
    metrics.mockResolvedValue({
      health: { circuitOpen: true, reason: "auth_or_permission", dueCount: 12 },
    });
    renderList();

    expect(await screen.findByText(CIRCUIT_PAUSED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/auth_or_permission/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it("hides the banner when the circuit is closed", async () => {
    renderList();
    await screen.findByText("18 people · 21 journeys");
    expect(screen.queryByText(CIRCUIT_PAUSED_MESSAGE)).not.toBeInTheDocument();
  });

  it("copes with a person and post we never resolved", async () => {
    list.mockResolvedValue({
      rows: [row({ username: null, name: null, media: { id: null, permalink: null, caption: null } })],
      nextCursor: null,
    });
    renderList();
    expect(await screen.findByText("ig-1")).toBeInTheDocument();
  });
});
