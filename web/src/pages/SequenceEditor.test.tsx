// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { SequenceEditor } = await import("./SequenceEditor");

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/sequences/resource-1"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/sequences/:id" element={<SequenceEditor />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}

let resourceReads = 0;
let messageReads = 0;

beforeEach(() => {
  resourceReads = 0;
  messageReads = 0;
  api.mockReset().mockImplementation((path: string) => {
    if (path === "/resources/resource-1") {
      resourceReads += 1;
      return Promise.resolve({
        id: "resource-1",
        name: resourceReads === 1 ? "Original sequence" : "Server refresh",
        description: "Original description",
        createdAt: "2026-08-08T00:00:00.000Z",
      });
    }
    if (path === "/messages/by-resource/resource-1") {
      messageReads += 1;
      return Promise.resolve([
        {
          id: "message-1",
          resourceId: "resource-1",
          order: 0,
          type: "text",
          body: messageReads === 1 ? "Original body" : "Server changed body",
          mediaUrl: null,
        },
      ]);
    }
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

afterEach(cleanup);

describe("SequenceEditor local drafts", () => {
  it("does not overwrite an in-progress sequence name when its query refetches", async () => {
    const user = userEvent.setup();
    const client = renderEditor();
    const name = await screen.findByPlaceholderText("Sequence name");

    await user.clear(name);
    await user.type(name, "Draft sequence");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["resource", "resource-1"] });
    });
    await waitFor(() => expect(resourceReads).toBe(2));

    expect(name).toHaveValue("Draft sequence");
  });

  it("does not overwrite an in-progress step body when messages refetch", async () => {
    const user = userEvent.setup();
    const client = renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.type(body, "My unsaved step");
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["resource-messages", "resource-1"] });
    });
    await waitFor(() => expect(messageReads).toBe(2));

    expect(body).toHaveValue("My unsaved step");
  });
});
