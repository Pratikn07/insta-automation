// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("../lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  apiRead: (path: unknown) => api(path),
  ApiError: class ApiError extends Error {},
}));

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
