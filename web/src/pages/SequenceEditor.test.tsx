// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
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
  const router = createMemoryRouter(
    [
      { path: "/sequences/:id", element: <SequenceEditor /> },
      { path: "/sequences", element: <p>Sequences page</p> },
    ],
    { initialEntries: ["/sequences/resource-1"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

let resourceReads = 0;
let messageReads = 0;
let serverMessages: ResourceMessage[];
let rejectBodyPatch = false;
let rejectBodyPatchWithGenericError = false;
let bodyPatchPromise: Promise<ResourceMessage> | null = null;

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

function resourcePatchCalls() {
  return api.mock.calls.filter(
    ([path, options]) =>
      path === "/resources/resource-1" &&
      (options as { method?: string } | undefined)?.method === "PATCH",
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function setBody(value: string) {
  fireEvent.change(bodyTextarea(), { target: { value } });
}

beforeEach(() => {
  resourceReads = 0;
  messageReads = 0;
  serverMessages = [message()];
  rejectBodyPatch = false;
  rejectBodyPatchWithGenericError = false;
  bodyPatchPromise = null;
  api.mockReset().mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/resources/resource-1") {
      if (options?.method === "PATCH") {
        return Promise.resolve({
          id: "resource-1",
          name: "Updated sequence",
          description: "Original description",
          createdAt: "2026-08-08T00:00:00.000Z",
        });
      }
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
      if (bodyPatchPromise) return bodyPatchPromise;
      if (rejectBodyPatchWithGenericError) {
        return Promise.reject(
          new ApiError(500, { error: "internal_error" }, "Save unavailable"),
        );
      }
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

describe("SequenceEditor explicit saving", () => {
  it("starts clean and marks edited text unsaved without saving on blur", async () => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    setBody("Draft body");
    fireEvent.blur(bodyTextarea());

    expect(messagePatchCalls()).toHaveLength(0);
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("saves only dirty resource and message text when requested", async () => {
    const user = userEvent.setup();
    renderEditor();
    const name = await screen.findByPlaceholderText("Sequence name");

    await user.clear(name);
    await user.type(name, "Updated sequence");
    setBody("Updated message");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(resourcePatchCalls()).toHaveLength(1));
    await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
    expect(JSON.parse(resourcePatchCalls()[0][1].body)).toEqual({
      name: "Updated sequence",
      description: "Original description",
    });
    expect(JSON.parse(messagePatchCalls()[0][1].body)).toEqual({ body: "Updated message" });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("keeps failed fields dirty and retries only those fields", async () => {
    const user = userEvent.setup();
    rejectBodyPatchWithGenericError = true;
    renderEditor();
    const name = await screen.findByPlaceholderText("Sequence name");

    await user.clear(name);
    await user.type(name, "Updated sequence");
    setBody("Updated message");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Couldn't save — retry")).toBeInTheDocument();
    expect(resourcePatchCalls()).toHaveLength(1);
    rejectBodyPatchWithGenericError = false;

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(resourcePatchCalls()).toHaveLength(1);
    expect(messagePatchCalls()).toHaveLength(2);
  });

  it("keeps newer typing dirty when an older save snapshot finishes", async () => {
    const user = userEvent.setup();
    const pending = deferred<ResourceMessage>();
    bodyPatchPromise = pending.promise;
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("Submitted snapshot");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    setBody("Newer local draft");
    pending.resolve(message({ body: "Submitted snapshot" }));

    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it.each([
    ["Meta", { metaKey: true }],
    ["Control", { ctrlKey: true }],
  ])("saves with %s+S", async (_label, modifier) => {
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    setBody("Shortcut draft");
    const event = new KeyboardEvent("keydown", {
      key: "s",
      bubbles: true,
      cancelable: true,
      ...modifier,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(messagePatchCalls()).toHaveLength(1));
    expect(JSON.parse(messagePatchCalls()[0][1].body)).toEqual({ body: "Shortcut draft" });
  });

  it("disables save for a blank sequence name", async () => {
    const user = userEvent.setup();
    renderEditor();
    const name = await screen.findByPlaceholderText("Sequence name");

    await user.clear(name);

    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("asks before leaving with an unsaved draft", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    setBody("Unsaved body");

    await user.click(screen.getByRole("link", { name: "Back" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Discard unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bodyTextarea()).toHaveValue("Unsaved body");

    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Leave without saving" }));

    expect(await screen.findByText("Sequences page")).toBeInTheDocument();
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

  it("saves a complete 1,000-unit message when requested", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("x".repeat(1000));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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
    expect(await screen.findByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(messagePatchCalls()).toHaveLength(0);
  });

  it("accepts 500 emoji but rejects 501 emoji by Instagram code units", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");

    setBody("😀".repeat(500));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
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
    const user = userEvent.setup();
    rejectBodyPatch = true;
    renderEditor();
    await screen.findByPlaceholderText("What you want them to read.");
    const body = "x".repeat(1000);

    setBody(body);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

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
