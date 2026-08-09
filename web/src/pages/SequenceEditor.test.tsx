// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceMessage } from "@/lib/types";

const api = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { SequenceEditor } = await import("./SequenceEditor");
const { ApiError } = await import("@/lib/api");

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
let serverMessages: ResourceMessage[];
let rejectBodyPatch = false;

function message(overrides: Partial<ResourceMessage> = {}): ResourceMessage {
  return {
    id: "message-1",
    resourceId: "resource-1",
    order: 0,
    type: "text",
    body: "Original body",
    mediaUrl: null,
    ...overrides,
  };
}

function bodyTextarea() {
  return screen.getByPlaceholderText(
    /What you want them to read\.|Optional caption sent with the file\./,
  );
}

function messagePatchCalls() {
  return api.mock.calls.filter(([path]) => path === "/messages/message-1");
}

function setBody(value: string) {
  fireEvent.change(bodyTextarea(), { target: { value } });
}

beforeEach(() => {
  resourceReads = 0;
  messageReads = 0;
  serverMessages = [message()];
  rejectBodyPatch = false;
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
      return Promise.resolve(
        serverMessages.map((entry) => ({
          ...entry,
          body: messageReads === 1 ? entry.body : "Server changed body",
        })),
      );
    }
    if (path === "/messages/message-1") {
      if (rejectBodyPatch) {
        return Promise.reject(
          new ApiError(
            422,
            { error: "message_body_too_long" },
            "Message body exceeds Instagram's 1,000 character limit",
          ),
        );
      }
      return Promise.resolve({ ...serverMessages[0] });
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

describe("SequenceEditor Instagram guide message limits", () => {
  it("shows a normal counter below the warning threshold", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("x".repeat(899));

    expect(screen.getByText("899 / 1,000")).not.toHaveClass("text-amber-600");
    expect(bodyTextarea()).toHaveAttribute("aria-invalid", "false");
  });

  it("starts warning treatment at 900 code units", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("x".repeat(900));

    expect(screen.getByText("900 / 1,000")).toHaveClass("text-amber-600");
    expect(bodyTextarea()).toHaveAttribute("aria-invalid", "false");
  });

  it("saves a complete 1,000-unit message on blur", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("x".repeat(1000));
    fireEvent.blur(bodyTextarea());

    await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
    expect(JSON.parse(messagePatchCalls()[0][1].body)).toEqual({ body: "x".repeat(1000) });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  });

  it("keeps an over-limit draft visible after blur and query refetch without saving it", async () => {
    const client = renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    const overLimitBody = "x".repeat(1001);

    setBody(overLimitBody);
    fireEvent.blur(bodyTextarea());
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["resource-messages", "resource-1"] });
    });
    await waitFor(() => expect(messageReads).toBeGreaterThanOrEqual(2));

    expect(messagePatchCalls()).toHaveLength(0);
    expect(bodyTextarea()).toHaveValue(overLimitBody);
    expect(bodyTextarea()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("1,001 / 1,000")).toHaveClass("text-destructive");
    expect(
      screen.getByText(
        "Instagram allows 1,000 characters per message. Shorten this message or add another Text step.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
  });

  it.each([
    ["image", "https://example.com/image.png"],
    ["pdf", "https://example.com/document.pdf"],
  ] as const)("applies the same validation to %s captions", async (type, mediaUrl) => {
    serverMessages = [message({ type, mediaUrl })];
    renderEditor();
    await screen.findByPlaceholderText("Optional caption sent with the file.");

    setBody("x".repeat(1001));
    fireEvent.blur(bodyTextarea());

    expect(bodyTextarea()).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(
        "Instagram allows 1,000 characters per message. Shorten this message or add another Text step.",
      ),
    ).toBeInTheDocument();
    expect(messagePatchCalls()).toHaveLength(0);
  });

  it("accepts 500 emoji but rejects 501 emoji by Instagram code units", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("😀".repeat(500));
    fireEvent.blur(bodyTextarea());
    await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
    expect(screen.getByText("1,000 / 1,000")).toBeInTheDocument();

    setBody("😀".repeat(501));
    fireEvent.blur(bodyTextarea());

    expect(screen.getByText("1,002 / 1,000")).toHaveClass("text-destructive");
    expect(bodyTextarea()).toHaveAttribute("aria-invalid", "true");
    expect(messagePatchCalls()).toHaveLength(1);
    expect(await screen.findByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
  });

  it("shows server-side message length failures inline without replacing the draft", async () => {
    rejectBodyPatch = true;
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    const body = "x".repeat(1000);

    setBody(body);
    fireEvent.blur(bodyTextarea());

    await screen.findByText(
      "Instagram allows 1,000 characters per message. Shorten this message or add another Text step.",
    );
    expect(bodyTextarea()).toHaveValue(body);
  });

  it("renders one preview bubble for one over-limit authored text step", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    const authoredBody = "x".repeat(1001);

    setBody(authoredBody);

    const previewBubbles = document.querySelectorAll(
      "aside div.rounded-2xl.rounded-bl-sm.bg-neutral-800.px-3.py-2.text-\\[12px\\]",
    );
    expect(previewBubbles).toHaveLength(1);
    expect(previewBubbles[0]).toHaveTextContent(authoredBody);
  });
});
