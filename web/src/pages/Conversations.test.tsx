// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps canonical and raw history in independent requests and labels aliases", async () => {
    api.mockImplementation((path: string) => {
      if (path.startsWith("/conversations/counts")) {
        return Promise.resolve({
          awaiting_done: 0,
          completed: 1,
          expired: 0,
          retrying: 0,
          waitingOnReply: 0,
        });
      }
      if (path.startsWith("/conversations?") && path.includes("mode=raw")) {
        return Promise.resolve({
          items: [
            {
              id: "alias-1",
              igUserId: "person-1",
              keywordId: "keyword-1",
              state: "completed",
              delivery: null,
              createdAt: "2026-08-08T20:00:00.000Z",
              completedAt: "2026-08-08T21:00:00.000Z",
              keyword: { id: "keyword-1", keyword: "SLEEP" },
              historyRole: "alias",
              canonicalOwner: { id: "canonical-1" },
              aliasCount: 0,
            },
          ],
          nextCursor: null,
        });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /Waiting/ }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("mode=canonical")),
    );
    expect(screen.getByRole("button", { name: "Canonical" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Raw history" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("mode=raw")),
    );
    expect(await screen.findByText(/Alias history · canonical owner canonical-1/))
      .toBeInTheDocument();

    const paths = api.mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => path.includes("/conversations?") && path.includes("mode=canonical")))
      .toBe(true);
    expect(paths.some((path) => path.includes("/conversations?") && path.includes("mode=raw")))
      .toBe(true);
  });
});

describe("Conversations guide delivery review", () => {
  it("keeps an amber review badge beside draft status and renders every review above the draft", async () => {
    const draft = {
      id: "draft-1",
      kind: "reply",
      status: "pending_approval",
      revision: 1,
      suggestedText: "Here is a reply suggestion.",
      workingText: "Here is a reply suggestion.",
      approvedText: null,
      rationale: "Answers the newest message.",
      confidence: "high",
      warnings: [],
      errorCode: null,
      errorMessage: null,
      retryAt: null,
      inboundMessageId: "message-inbound",
      sourceConversationId: null,
      eligibleAt: "2026-08-09T10:00:00.000Z",
      expiresAt: null,
      promptVersion: 2,
      promptPolicyCurrent: true,
      sourceGuide: null,
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      createdAt: "2026-08-09T10:00:00.000Z",
    } as const;
    const reviews = [
      {
        id: "delivery-one",
        status: "needs_review",
        confirmedUnits: 0,
        totalUnits: 1,
        sendWindowExpiresAt: "2026-08-09T12:00:00.000Z",
        sendWindowOpen: true,
        failureCode: "guide_unit_uncertain",
        units: [{ id: "unit-one", position: 0, kind: "text", status: "uncertain" }],
      },
      {
        id: "delivery-two",
        status: "needs_review",
        confirmedUnits: 1,
        totalUnits: 2,
        sendWindowExpiresAt: "2026-08-09T12:00:00.000Z",
        sendWindowOpen: true,
        failureCode: "guide_unit_uncertain",
        units: [
          { id: "unit-two-sent", position: 0, kind: "image", status: "sent" },
          { id: "unit-two", position: 1, kind: "file", status: "uncertain" },
        ],
      },
    ] as const;

    api.mockImplementation((path: string) => {
      if (path === "/dm-threads?scope=needs_reply") {
        return Promise.resolve({
          items: [{
            id: "thread-review",
            igUserId: "ig-review",
            username: "geri",
            name: "Geri",
            needsReply: true,
            latestInboundMessageId: "message-inbound",
            lastMessageAt: "2026-08-09T10:00:00.000Z",
            lastInboundAt: "2026-08-09T10:00:00.000Z",
            lastOutboundAt: null,
            latestMessage: {
              direction: "inbound",
              text: "Can you help?",
              type: "text",
              source: "instagram",
              instagramTimestamp: "2026-08-09T10:00:00.000Z",
            },
            draft,
            deliveryReviewCount: 2,
          }],
          nextCursor: null,
        });
      }
      if (path === "/dm-threads/thread-review") {
        return Promise.resolve({
          id: "thread-review",
          igUserId: "ig-review",
          username: "geri",
          name: "Geri",
          needsReply: true,
          latestInboundMessageId: "message-inbound",
          lastMessageAt: "2026-08-09T10:00:00.000Z",
          messages: [{
            id: "message-inbound",
            direction: "inbound",
            text: "Can you help?",
            type: "text",
            source: "instagram",
            mediaUrl: null,
            instagramTimestamp: "2026-08-09T10:00:00.000Z",
          }],
          draft,
          deliveryReviews: reviews,
        });
      }
      if (path === "/ai/capabilities") {
        return Promise.resolve({ draftingEnabled: true, followUpsEnabled: true, sendEnabled: true });
      }
      if (path.startsWith("/conversations/counts")) {
        return Promise.resolve({
          awaiting_done: 0,
          completed: 0,
          expired: 0,
          retrying: 0,
          waitingOnReply: 1,
        });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    renderPage();

    const username = await screen.findByText("@geri");
    const row = username.closest("button");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("Draft ready")).toBeInTheDocument();
    expect(within(row!).getByText("Delivery needs review")).toBeInTheDocument();

    await userEvent.click(row!);

    const drawer = await screen.findByRole("dialog");
    const reviewHeadings = within(drawer).getAllByRole("heading", {
      name: "Delivery needs review",
    });
    expect(reviewHeadings).toHaveLength(2);
    expect(
      within(drawer).getByRole("button", { name: "Cancel delivery delivery-one" }),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Cancel delivery delivery-two" }),
    ).toBeInTheDocument();
    const draftEditor = within(drawer).getByRole("textbox", { name: "Reply draft" });
    for (const heading of reviewHeadings) {
      expect(heading.compareDocumentPosition(draftEditor) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
  });
});
