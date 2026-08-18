// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const apiMutation = vi.fn();

vi.mock("../lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...args: unknown[]) => apiMutation(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
      "/sequences/resource-attention",
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
    await user.click(screen.getAllByRole("button", { name: /New sequence/ })[0]);
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

    await user.click(screen.getByRole("button", { name: /Create sequence|Create/ }));

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

    const submit = screen.getByRole("button", { name: /Create sequence|Create/ });
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
