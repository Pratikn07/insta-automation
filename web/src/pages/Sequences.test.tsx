// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { Sequences } = await import("./Sequences");

function renderSequences() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Sequences />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/resources") {
      return Promise.resolve([
        {
          id: "clean-resource",
          name: "Clean guide",
          description: null,
          createdAt: "2026-08-09T00:00:00.000Z",
          _count: { messages: 1, keywords: 1 },
        },
        {
          id: "needs-attention-resource",
          name: "Legacy guide",
          description: null,
          createdAt: "2026-08-09T00:00:00.000Z",
          _count: { messages: 2, keywords: 1 },
          invalidMessageCount: 2,
        },
      ]);
    }
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

afterEach(cleanup);

describe("sequence guide-message attention", () => {
  it("links only the affected sequence card to the editor with its invalid message count", async () => {
    renderSequences();

    const attention = await screen.findByText("2 messages need attention");
    expect(attention.closest("a")).toHaveAttribute("href", "/sequences/needs-attention-resource");

    const cleanCard = screen.getByText("Clean guide").closest("li");
    expect(cleanCard).not.toHaveTextContent("need attention");
  });
});
