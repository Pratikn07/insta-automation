// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceMessage } from "@/lib/types";

const api = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  ApiError: class ApiError extends Error {},
  apiErrorCode: (error: { code?: unknown }) =>
    typeof error?.code === "string" ? error.code : null,
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

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
let patchErrorCode: string | null = null;
let initialMessages: ResourceMessage[] = [];

const originalMessage = {
  id: "message-1",
  resourceId: "resource-1",
  order: 0,
  type: "text" as const,
  body: "Original body",
  mediaUrl: null,
};

function firstMessage() {
  return {
    body: () => screen.getByPlaceholderText("What you want them to read."),
    patchCalls: () => api.mock.calls.filter(([path]) => path === "/messages/message-1"),
  };
}

function messageFixture(type: ResourceMessage["type"]): ResourceMessage {
  return {
    ...originalMessage,
    type,
    body: "",
    mediaUrl: type === "text" ? null : `https://example.com/asset.${type === "pdf" ? "pdf" : "jpg"}`,
  };
}

beforeEach(() => {
  resourceReads = 0;
  messageReads = 0;
  patchErrorCode = null;
  initialMessages = [originalMessage];
  toastError.mockReset();
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
        ...initialMessages.map((message) => ({
          ...message,
          body: messageReads === 1 ? message.body : "Server changed body",
        })),
      ]);
    }
    if (path === "/messages/message-1") {
      if (patchErrorCode) {
        return Promise.reject(Object.assign(new Error("Message too long"), { code: patchErrorCode }));
      }
      return Promise.resolve(originalMessage);
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

describe("SequenceEditor Instagram message limits", () => {
  it("shows a normal counter at 899 characters and starts the warning at 900", async () => {
    const user = userEvent.setup();
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.paste("a".repeat(899));
    expect(screen.getByText("899 / 1,000 characters")).not.toHaveClass("text-caution");

    await user.clear(body);
    await user.paste("a".repeat(900));
    expect(screen.getByText("900 / 1,000 characters")).toHaveClass("text-caution");
  });

  it("saves exactly 1,000 code points on blur", async () => {
    const user = userEvent.setup();
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.paste("a".repeat(1_000));
    fireEvent.blur(body);

    await waitFor(() => expect(firstMessage().patchCalls()).toHaveLength(1));
    expect(firstMessage().patchCalls()[0][1]).toMatchObject({ method: "PATCH" });
  });

  it("blocks a 1,001-code-point draft, keeps it through refetch, and marks the sequence for attention", async () => {
    const user = userEvent.setup();
    const client = renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");
    const tooLong = "a".repeat(1_001);

    await user.clear(body);
    await user.paste(tooLong);
    fireEvent.blur(body);

    expect(body).toHaveValue(tooLong);
    expect(body).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Instagram allows 1,000 characters per message/)).toBeVisible();
    expect(screen.getByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
    expect(firstMessage().patchCalls()).toHaveLength(0);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["resource-messages", "resource-1"] });
    });
    await waitFor(() => expect(messageReads).toBe(2));
    expect(firstMessage().body()).toHaveValue(tooLong);
  });

  it("uses code points for emoji at the exact boundary", async () => {
    const user = userEvent.setup();
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.paste("🙂".repeat(1_000));
    fireEvent.blur(body);
    await waitFor(() => expect(firstMessage().patchCalls()).toHaveLength(1));

    await user.clear(body);
    await user.paste("🙂".repeat(1_001));
    fireEvent.blur(body);
    expect(screen.getByText("1,001 / 1,000 characters")).toBeVisible();
    expect(body).toHaveAttribute("aria-invalid", "true");
    expect(firstMessage().patchCalls()).toHaveLength(1);
  });

  it("keeps a matching server length error inline instead of replacing it with a toast", async () => {
    const user = userEvent.setup();
    patchErrorCode = "message_body_too_long";
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.paste("a".repeat(1_000));
    fireEvent.blur(body);

    await waitFor(() => expect(firstMessage().patchCalls()).toHaveLength(1));
    expect(screen.getByText(/Instagram allows 1,000 characters per message/)).toBeVisible();
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each(["image", "pdf"] as const)("applies the same limit to %s captions", async (type) => {
    const user = userEvent.setup();
    initialMessages = [messageFixture(type)];
    renderEditor();
    const caption = await screen.findByPlaceholderText("Optional caption sent with the file.");

    await user.click(caption);
    await user.paste("a".repeat(1_001));
    fireEvent.blur(caption);

    expect(caption).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("1,001 / 1,000 characters")).toBeVisible();
    expect(firstMessage().patchCalls()).toHaveLength(0);
  });

  it("renders each authored over-limit text step as one preview bubble", async () => {
    const user = userEvent.setup();
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");
    const tooLong = "a".repeat(1_001);

    await user.clear(body);
    await user.paste(tooLong);

    expect(screen.getAllByText(tooLong).filter((node) => node.tagName !== "TEXTAREA")).toHaveLength(1);
  });
});
