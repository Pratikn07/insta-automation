// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const apiMutation = vi.fn();

/**
 * Carries `status` and `body` like the real one, because the delete refusals are
 * read from `body.error` rather than from the message. The old bare `extends Error`
 * stub could not represent them.
 */
class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

vi.mock("../lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...args: unknown[]) => apiMutation(...args),
  ApiError,
  // Mirrors lib/api.ts: the code is a string at `body.error`, never parsed out of
  // the message. Same stub as GuideDeliveryReviewCard.test.tsx.
  apiErrorCode: (error: unknown) =>
    error instanceof ApiError && error.body && typeof error.body === "object"
      ? ((error.body as { error?: unknown }).error as string | null) ?? null
      : null,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m) } }));

const { Sequences } = await import("./Sequences");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Sequences />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  apiMutation.mockReset();
  toastError.mockReset();
  api.mockReset().mockResolvedValue([
    {
      id: "resource-clean",
      name: "Clean guide",
      description: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      _count: { messages: 1, keywords: 1 },
    },
    {
      id: "resource-attention",
      name: "Needs editing",
      description: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      _count: { messages: 2, keywords: 1 },
      invalidMessageCount: 2,
    },
  ]);
});

describe("Sequences", () => {
  it("flags only cards with over-limit messages and links to their editor", async () => {
    renderPage();

    const attentionCard = (await screen.findByText("Needs editing")).closest("li")!;
    expect(within(attentionCard).getByText("2 messages need attention")).toBeInTheDocument();
    expect(within(attentionCard).getByRole("link")).toHaveAttribute(
      "href",
      "/guides/resource-attention",
    );

    const cleanCard = screen.getByText("Clean guide").closest("li")!;
    expect(within(cleanCard).queryByText(/need attention/)).not.toBeInTheDocument();
  });
});

// The client owns the new row's UUID. Its value is unremarkable; what matters is
// that it does not change when the first attempt's outcome is unknown, because a
// fresh UUID would ask the server for a second sequence.
describe("Sequences create identity", () => {
  async function openCreateForm() {
    const user = userEvent.setup();
    renderPage();
    // Let the resources read settle first: a refetch mid-typing re-renders the
    // drawer and detaches the input.
    await waitFor(() => expect(api).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: /New guide/ })[0]);
    // One atomic change rather than per-keystroke typing, for the same reason.
    fireEvent.change(screen.getByPlaceholderText("Toddler Activity Guide"), {
      target: { value: "Sleep guide" },
    });
    return user;
  }

  function lastCreateCall() {
    const call = apiMutation.mock.calls.at(-1);
    return {
      path: String(call?.[0]),
      options: call?.[1] as { operationId?: string; body?: string },
    };
  }

  it("sends one UUID as both the row id and the idempotency key", async () => {
    apiMutation.mockResolvedValue({ id: "resource-new" });
    const user = await openCreateForm();

    await user.click(screen.getByRole("button", { name: /Create guide/ }));

    await waitFor(() => expect(apiMutation).toHaveBeenCalled());
    const { path, options } = lastCreateCall();
    expect(path).toBe("/resources");
    const body = JSON.parse(String(options.body));
    expect(body.id).toBe(options.operationId);
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body.name).toBe("Sleep guide");
  });

  it("repeats the same UUID after an unknown outcome", async () => {
    apiMutation.mockRejectedValueOnce(new Error("unknown outcome"));
    const user = await openCreateForm();

    const submit = screen.getByRole("button", { name: /Create guide/ });
    await user.click(submit);
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));
    const first = lastCreateCall().options.operationId;

    apiMutation.mockResolvedValue({ id: "resource-new" });
    await user.click(submit);
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));

    // Same intent, same key: the server can recognise the replay.
    expect(lastCreateCall().options.operationId).toBe(first);
  });
});

/**
 * Every refusal has to say what is holding the guide, because none of them are
 * things the owner can guess.
 *
 * These all previously read "Delete failed" or, worse, the raw server code —
 * `ApiError.message` is the code verbatim. The upcoming-setup case was reachable as
 * soon as a guide could be created from the Content form, and it left no way out.
 */
describe("Sequences delete refusals", () => {
  async function attemptDelete() {
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole("button", { name: "Delete guide" }))[0]!);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    return user;
  }

  it("names the waiting setup and where to cancel it", async () => {
    apiMutation.mockRejectedValue(
      new ApiError(
        409,
        { error: "resource_has_upcoming_setup", triggerWords: ["TEST"], clearable: true },
        "resource_has_upcoming_setup",
      ),
    );

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'A setup waiting for a post (TEST) uses this guide. Cancel it on Content first.',
      ),
    );
  });

  // Telling her to cancel something already cancelled would send her to Content to
  // look for a row that is not there.
  it("does not tell her to cancel a setup that is already resolved", async () => {
    apiMutation.mockRejectedValue(
      new ApiError(
        409,
        { error: "resource_has_upcoming_setup", triggerWords: ["OLDWORD"], clearable: false },
        "resource_has_upcoming_setup",
      ),
    );

    await attemptDelete();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toContain("A past setup (OLDWORD)");
    expect(toastError.mock.calls[0]![0]).not.toMatch(/cancel/i);
  });

  it("explains delivery history rather than printing its error code", async () => {
    apiMutation.mockRejectedValue(
      new ApiError(409, { error: "resource_has_delivery_history" }, "resource_has_delivery_history"),
    );

    await attemptDelete();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toContain("already been sent");
    expect(toastError.mock.calls[0]![0]).not.toContain("resource_has_delivery_history");
  });

  // No code, no body: still a sentence, never "HTTP 500".
  it("stays readable when the failure carries no code at all", async () => {
    apiMutation.mockRejectedValue(new Error("network down"));

    await attemptDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not delete this guide. Check your connection and try again.",
      ),
    );
  });
});
