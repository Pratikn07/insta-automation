// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

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
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/upcoming-automations") {
      return Promise.resolve({ automations: [waiting], discoveryEnabled: false });
    }
    return Promise.resolve(waiting);
  });
});

describe("UpcomingAutomations", () => {
  it("explains the local-only setup and clearly shows paused discovery", async () => {
    renderUpcoming();

    expect(await screen.findByText("HIGHCHAIR")).toBeInTheDocument();
    expect(screen.getByText("Automatic discovery is paused")).toBeInTheDocument();
    expect(screen.getByText(/Instagram does not provide scheduled previews/)).toBeInTheDocument();
    expect(screen.getByText("High-chair guide")).toBeInTheDocument();
    expect(screen.getByText("Waiting for post")).toBeInTheDocument();
  });

  it("validates one alphanumeric keyword token before creation", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Add upcoming setup" }));
    await user.type(screen.getByLabelText("Keyword"), "two words");

    expect(screen.getByText("Use one word with letters and numbers only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create setup" })).toBeDisabled();
  });

  it("creates a normalized setup with the chosen guide and reply snapshots", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Add upcoming setup" }));
    await user.type(screen.getByLabelText("Keyword"), "highchair");
    await user.selectOptions(screen.getByLabelText("Guide"), resources[0]!.id);
    await user.type(screen.getByLabelText("Public reply"), "Sent! Check your DMs.");
    await user.type(screen.getByLabelText("Gate message"), "Follow and reply DONE.");
    await user.click(screen.getByRole("button", { name: "Create setup" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/upcoming-automations", {
        method: "POST",
        body: JSON.stringify({
          keyword: "HIGHCHAIR",
          resourceId: resources[0]!.id,
          publicReply: "Sent! Check your DMs.",
          gateMessage: "Follow and reply DONE.",
          active: true,
        }),
      }),
    );
  });

  it("edits a waiting setup", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Edit HIGHCHAIR" }));
    const publicReply = screen.getByLabelText("Public reply");
    await user.clear(publicReply);
    await user.type(publicReply, "Updated reply");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/upcoming-automations/setup-1", {
        method: "PATCH",
        body: expect.stringContaining('"publicReply":"Updated reply"'),
      }),
    );
  });

  it("confirms cancellation before making the setup terminal", async () => {
    const user = userEvent.setup();
    renderUpcoming();

    await user.click(await screen.findByRole("button", { name: "Cancel HIGHCHAIR" }));
    expect(screen.getByRole("dialog", { name: "Cancel upcoming setup?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel setup" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/upcoming-automations/setup-1/cancel", {
        method: "POST",
      }),
    );
  });

  it("offers retry only for a needs-attention setup", async () => {
    api.mockImplementation((path: string) => {
      if (path === "/upcoming-automations") {
        return Promise.resolve({
          automations: [{ ...waiting, status: "needs_attention", errorCode: "caption_instruction_mismatch" }],
          discoveryEnabled: true,
        });
      }
      return Promise.resolve(waiting);
    });
    const user = userEvent.setup();
    renderUpcoming();

    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry HIGHCHAIR" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/upcoming-automations/setup-1/retry", {
        method: "POST",
      }),
    );
  });
});
