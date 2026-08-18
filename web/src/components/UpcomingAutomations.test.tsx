// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRead = vi.fn();
const apiMutation = vi.fn();

vi.mock("../lib/api", () => ({
  apiRead: (...args: unknown[]) => apiRead(...args),
  apiMutation: (...args: unknown[]) => apiMutation(...args),
}));

// A fixed id makes the create body assertable. The real hook mints a UUID per
// attempt; what matters here is that the SAME one reaches the body and the header.
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const renew = vi.fn();
vi.mock("../lib/useOperationId", () => ({
  useOperationId: () => ({ operationId: OPERATION_ID, renew }),
}));

const { UpcomingAutomations } = await import("./UpcomingAutomations");

const resources = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "High-chair guide",
    description: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    _count: { messages: 3, keywords: 0 },
  },
];

const waiting = {
  id: "setup-1",
  triggerWord: "HIGHCHAIR",
  resourceId: resources[0]!.id,
  publicReply: "Sent! Check your DMs.",
  gateMessage: "Follow and reply DONE.",
  active: true,
  status: "waiting",
  matchedMediaId: null,
  keywordId: null,
  errorCode: null,
  createdBy: "owner@example.com",
  lastAttemptAt: null,
  retriedAt: null,
  boundAt: null,
  cancelledAt: null,
  createdAt: "2026-08-16T18:00:00.000Z",
  updatedAt: "2026-08-16T18:00:00.000Z",
  resource: { id: resources[0]!.id, name: "High-chair guide", _count: { messages: 3 } },
};

function listOf(rows: unknown[], discoveryEnabled = false) {
  apiRead.mockResolvedValue({ automations: rows, discoveryEnabled });
}

function renderUpcoming() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <UpcomingAutomations resources={resources} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(cleanup);

beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset().mockResolvedValue(waiting);
  renew.mockReset();
  listOf([waiting]);
});

describe("UpcomingAutomations", () => {
  it("says what these are waiting for, and names the paused state honestly", async () => {
    renderUpcoming();

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText("Automatic attaching is paused")).toBeInTheDocument();
    expect(screen.getByText(/Instagram doesn't let us see your scheduled queue/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for the post to publish/)).toBeInTheDocument();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
  });

  // The paused state suppresses the legacy fallback too. Saying only "will not
  // attach" would hide the half that costs her replies.
  it("warns that a paused word also blocks the older post's keyword", async () => {
    renderUpcoming();

    expect(
      await screen.findByText(/will not fall back to an older post's keyword/),
    ).toBeInTheDocument();
  });

  it("reads the list through apiRead with an abort signal", async () => {
    renderUpcoming();

    await screen.findByText("HIGHCHAIR");
    expect(apiRead).toHaveBeenCalledWith(
      "/upcoming-automations",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("validates one alphanumeric keyword token before creation", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: /Set up another/ }));
    await user.type(screen.getByLabelText("Keyword"), "two words");

    expect(screen.getByText("Use one word with letters and numbers only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create setup" })).toBeDisabled();
  });

  it("sends the client-owned id in both the body and the idempotency header", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: /Set up another/ }));
    await user.type(screen.getByLabelText("Keyword"), "highchair");
    await user.selectOptions(screen.getByLabelText("Guide"), resources[0]!.id);
    await user.type(screen.getByLabelText("Public reply"), "Sent! Check your DMs.");
    await user.type(screen.getByLabelText("Gate message"), "Follow and reply DONE.");
    await user.click(screen.getByRole("button", { name: "Create setup" }));

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/upcoming-automations", {
        method: "POST",
        operationId: OPERATION_ID,
        body: JSON.stringify({
          id: OPERATION_ID,
          keyword: "HIGHCHAIR",
          resourceId: resources[0]!.id,
          publicReply: "Sent! Check your DMs.",
          gateMessage: "Follow and reply DONE.",
          active: true,
        }),
      }),
    );
    // Only after a create lands does the next one get a new identity.
    await waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
  });

  it("does not renew the create identity after an edit", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Edit HIGHCHAIR" }));
    const publicReply = screen.getByLabelText("Public reply");
    await user.clear(publicReply);
    await user.type(publicReply, "Updated reply");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/upcoming-automations/setup-1", {
        method: "PATCH",
        body: expect.stringContaining('"publicReply":"Updated reply"'),
      }),
    );
    expect(renew).not.toHaveBeenCalled();
  });

  it("confirms cancellation before making the setup terminal", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Cancel HIGHCHAIR" }));
    expect(screen.getByRole("dialog", { name: "Cancel this setup?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/upcoming-automations/setup-1/cancel", {
        method: "POST",
      }),
    );
  });

  it("offers retry only for a needs-attention setup, and explains the cause", async () => {
    listOf(
      [{ ...waiting, status: "needs_attention", errorCode: "caption_instruction_mismatch" }],
      true,
    );
    const user = userEvent.setup();
    renderUpcoming();

    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(/published caption uses a different keyword/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry HIGHCHAIR" }));

    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/upcoming-automations/setup-1/retry", {
        method: "POST",
      }),
    );
  });

  it("shows an unknown error code rather than swallowing it", async () => {
    listOf([{ ...waiting, status: "needs_attention", errorCode: "something_new" }]);
    renderUpcoming();

    expect(await screen.findByText(/needs review: something_new/)).toBeInTheDocument();
  });

  // A bound row is a receipt: it reads as something that already happened, and it
  // carries no Edit or Cancel, because there is nothing left to edit or cancel.
  it("renders an attached setup as a finished receipt with no actions", async () => {
    listOf([
      {
        ...waiting,
        status: "bound",
        boundAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        matchedMediaId: "media-1",
        keywordId: "keyword-1",
      },
    ]);
    renderUpcoming();

    expect(await screen.findByText("Attached")).toBeInTheDocument();
    expect(screen.getByText(/attached itself 2 hours ago/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit HIGHCHAIR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel HIGHCHAIR" })).not.toBeInTheDocument();
  });

  // "Bound" is what the database calls it. She is attaching a keyword to a post.
  it("never says Bound to the owner", async () => {
    listOf([{ ...waiting, status: "bound", boundAt: waiting.createdAt }]);
    const { container } = renderUpcoming();

    await screen.findByText("Attached");
    expect(container.textContent).not.toMatch(/\bbound\b/i);
  });

  // Content has no header action. With an empty list and the create living only
  // inside the list, she would have no way to make her first one.
  it("keeps a way in when there is nothing set up yet", async () => {
    listOf([]);
    const user = userEvent.setup();
    renderUpcoming();

    const door = await screen.findByRole("button", { name: "Set up its keyword in advance" });
    expect(screen.getByText(/Scheduled a post that isn't here yet\?/)).toBeInTheDocument();

    await user.click(door);
    expect(screen.getByLabelText("Keyword")).toBeInTheDocument();
  });

  it("calls a failed read a connection problem, not an empty list", async () => {
    apiRead.mockRejectedValue(new Error("network down"));
    renderUpcoming();

    expect(await screen.findByText(/connection problem, not an empty list/)).toBeInTheDocument();
    // Absence of data is never rendered as absence of setups.
    expect(
      screen.queryByRole("button", { name: "Set up its keyword in advance" }),
    ).not.toBeInTheDocument();
  });
});
