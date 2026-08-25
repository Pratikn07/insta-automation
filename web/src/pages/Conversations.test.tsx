// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recoveryList = vi.fn();
const recoveryCounts = vi.fn();
const recoveryMetrics = vi.fn();
const api = vi.fn();

vi.mock("../lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => api(...a),
  recoveryApi: {
    list: (query: unknown) => recoveryList(query),
    counts: () => recoveryCounts(),
    metrics: () => recoveryMetrics(),
    detail: vi.fn(),
    cancel: vi.fn(),
    markReviewed: vi.fn(),
  },
}));

const { Conversations } = await import("./Conversations");

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>History back</button>
      <button type="button" onClick={() => navigate(1)}>History forward</button>
    </>
  );
}

function renderPage(initialEntry = "/conversations") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <Conversations />
        <LocationProbe />
        <HistoryControls />
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

describe("Conversations lenses", () => {
  it("keeps Needs reply as the default", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Needs reply" })).toBeInTheDocument();
  });

  // The safety boundary, asserted rather than assumed. Every control in this row
  // reads what already happened; DM recovery can publish a public reminder to real
  // people and now lives on its own route. A pill that reappears here would put a
  // sending control one habitual click from a reading one.
  it("has no DM recovery lens and never fetches recovery", () => {
    renderPage();

    for (const label of ["Needs reply", "DMs", "People"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /recovery/i })).not.toBeInTheDocument();
    expect(recoveryList).not.toHaveBeenCalled();
    expect(recoveryCounts).not.toHaveBeenCalled();
  });

  // People arrived from /users. It reads the same conversations indexed by
  // person, so unlike recovery it belongs in this row.
  it("loads the directory on the People lens", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "People" }));

    expect(screen.getByLabelText("location")).toHaveTextContent("/conversations?lens=people");
    await waitFor(() =>
      expect(api.mock.calls.some((c) => String(c[0]).startsWith("/users"))).toBe(true),
    );
    expect(screen.getByPlaceholderText("Search by @username or name…")).toBeInTheDocument();
  });

  it("opens the People lens directly from its URL", async () => {
    renderPage("/conversations?lens=people");

    expect(screen.getByRole("button", { name: "People" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(api.mock.calls.some((call) => String(call[0]).startsWith("/users"))).toBe(true),
    );
    expect(screen.getByPlaceholderText("Search by @username or name…")).toBeInTheDocument();
  });

  it("falls back safely for an unknown lens", () => {
    renderPage("/conversations?lens=unknown");
    expect(screen.getByRole("button", { name: "Needs reply" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preserves unrelated search parameters when changing lens", async () => {
    renderPage("/conversations?source=bookmark");

    await userEvent.click(screen.getByRole("button", { name: "People" }));
    const location = screen.getByLabelText("location").textContent ?? "";
    const search = new URL(location, "https://tinysoho.test").searchParams;
    expect(search.get("source")).toBe("bookmark");
    expect(search.get("lens")).toBe("people");
  });

  it("restores lenses through browser history", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "People" }));
    await user.click(screen.getByRole("button", { name: "DMs" }));
    await user.click(screen.getByRole("button", { name: "History back" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "People" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    await user.click(screen.getByRole("button", { name: "History forward" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "DMs" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  // Not tested: that /ai/capabilities is disabled on the People lens. The page
  // opens on Needs reply, which fetches it legitimately, and React Query serves
  // the cached result thereafter — so the assertion passes identically with the
  // guard right or wrong. The narrowed `enabled` still belongs in the source; a
  // test that cannot fail for the reason it claims does not belong here.

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
    ["DMs", "dms"],
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

// An unresolved guide delivery is the automation's own unfinished business. It has
// to be visible from the list without opening anything, and it has to be visible
// even on a thread whose reply draft looks perfectly ordinary — those are two
// independent facts about the same person.
describe("guide delivery review in Conversations", () => {
  const THREAD_ID = "44444444-4444-4444-8444-444444444444";

  function threadRow(deliveryReviewCount: number, accessReviewCount = 0) {
    return {
      id: THREAD_ID,
      igUserId: "ig-99",
      username: "geri",
      name: "Geri",
      needsReply: false,
      latestInboundMessageId: "msg-1",
      lastMessageAt: "2026-08-16T10:00:00.000Z",
      lastInboundAt: "2026-08-16T09:00:00.000Z",
      lastOutboundAt: "2026-08-16T10:00:00.000Z",
      latestMessage: {
        direction: "outbound",
        text: "Sent you the guide",
        type: "text",
        source: "automation",
        instagramTimestamp: "2026-08-16T10:00:00.000Z",
      },
      draft: null,
      deliveryReviewCount,
      accessReviewCount,
    };
  }

  const ACCESS_REVIEW = {
    attemptId: "66666666-6666-4666-8666-666666666666",
    conversationId: "77777777-7777-4777-8777-777777777777",
    resourceName: "Toddler sleep guide",
    state: "needs_review",
    lastFollowResult: "unknown",
    followCheckCount: 5,
    followResponseCount: 3,
    messagingWindowExpiresAt: "2026-08-25T10:00:00.000Z",
    messagingWindowOpen: true,
    canRelease: true,
    canResendAction: true,
  };

  const REVIEW = {
    id: "55555555-5555-4555-8555-555555555555",
    status: "needs_review",
    confirmedUnits: 1,
    totalUnits: 3,
    sendWindowExpiresAt: "2026-08-17T10:00:00.000Z",
    sendWindowOpen: true,
    failureCode: null,
    units: [
      { id: "unit-a", position: 0, kind: "text", status: "sent" },
      { id: "unit-b", position: 1, kind: "image", status: "uncertain" },
      { id: "unit-c", position: 2, kind: "text", status: "pending" },
    ],
  };

  function mockDmThreads(reviewCount: number, accessReviewCount = 0) {
    api.mockImplementation((path: string) => {
      const p = String(path);
      if (p.startsWith("/dm-threads?")) {
        return Promise.resolve({ items: [threadRow(reviewCount, accessReviewCount)], nextCursor: null });
      }
      if (p === `/dm-threads/${THREAD_ID}`) {
        return Promise.resolve({
          ...threadRow(reviewCount, accessReviewCount),
          messages: [],
          deliveryReviews: reviewCount > 0 ? [REVIEW] : [],
          accessReviews: accessReviewCount > 0 ? [ACCESS_REVIEW] : [],
        });
      }
      if (p.startsWith("/keywords")) return Promise.resolve([]);
      return Promise.resolve({ items: [], nextCursor: null });
    });
  }

  it("badges a thread whose delivery needs review even with no draft", async () => {
    mockDmThreads(1);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "DMs" }));

    expect(await screen.findByText("Delivery needs review")).toBeInTheDocument();
  });

  it("shows no delivery badge when nothing needs review", async () => {
    mockDmThreads(0);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "DMs" }));
    await waitFor(() => expect(screen.getByText("@geri")).toBeInTheDocument());

    expect(screen.queryByText("Delivery needs review")).not.toBeInTheDocument();
  });

  it("resolves the delivery from the thread drawer without exposing content", async () => {
    mockDmThreads(1);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "DMs" }));
    await user.click(await screen.findByText("@geri"));

    expect(await screen.findByText("1 of 3 messages confirmed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already delivered" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel delivery" })).toBeEnabled();
  });

  it("badges and opens an access review independently of delivery review", async () => {
    mockDmThreads(0, 1);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "DMs" }));
    expect(await screen.findByText("Guide access needs review")).toBeInTheDocument();
    await user.click(await screen.findByText("@geri"));

    expect(await screen.findByText(/Toddler sleep guide · 5 access checks · 3 follow responses/i))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend action" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Release request" })).toBeEnabled();
  });
});
