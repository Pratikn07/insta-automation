// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const apiMutation = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Insights } = await import("./Insights");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Insights />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMutation.mockReset();
  // The page reads several endpoints; an empty envelope satisfies all of them.
  api.mockReset().mockResolvedValue({ items: [], points: [], stages: [] });
});

afterEach(cleanup);

/**
 * An experiment's baseline is measured at creation, which makes a duplicate
 * expensive: two rows would each claim to be measuring the same change from a
 * different starting point. The client UUID is what stops that.
 */
describe("Insights experiment create identity", () => {
  async function openExperimentForm() {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Experiments" }));
    await user.click(await screen.findByRole("button", { name: /New experiment/ }));

    fireEvent.change(screen.getByLabelText("Hypothesis"), {
      target: { value: "Trending US audio lifts reach" },
    });
    fireEvent.change(screen.getByLabelText(/the variable/i), {
      target: { value: "trending US audio" },
    });
    return user;
  }

  function lastCreateCall() {
    return apiMutation.mock.calls
      .filter(([p]) => String(p) === "/insights/experiments")
      .at(-1)?.[1] as { operationId?: string; body?: string } | undefined;
  }

  it("sends one UUID as both the experiment id and the idempotency key", async () => {
    apiMutation.mockResolvedValue({ id: "exp-1" });
    const user = await openExperimentForm();

    await user.click(screen.getByRole("button", { name: "Start experiment" }));

    await waitFor(() => expect(lastCreateCall()).toBeDefined());
    const options = lastCreateCall()!;
    const body = JSON.parse(String(options.body));
    expect(body.id).toBe(options.operationId);
    expect(body.hypothesis).toBe("Trending US audio lifts reach");
  });

  it("repeats the same UUID after an unknown outcome", async () => {
    apiMutation.mockRejectedValueOnce(new Error("unknown outcome"));
    const user = await openExperimentForm();

    const start = screen.getByRole("button", { name: "Start experiment" });
    await user.click(start);
    await waitFor(() => expect(lastCreateCall()).toBeDefined());
    const first = lastCreateCall()!.operationId;

    apiMutation.mockResolvedValue({ id: "exp-1" });
    await user.click(start);
    await waitFor(() =>
      expect(
        apiMutation.mock.calls.filter(([p]) => String(p) === "/insights/experiments").length,
      ).toBe(2),
    );

    // A fresh UUID here would have created a second experiment measuring the same
    // change from a second baseline.
    expect(lastCreateCall()!.operationId).toBe(first);
  });
});
