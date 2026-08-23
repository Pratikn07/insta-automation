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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

// Reads and mutations route to one spy: the assertions are about paths and methods,
// which both clients pass through unchanged.
vi.mock("@/lib/api", () => ({
  apiRead: (path: unknown) => api(path),
  apiMutation: (...args: unknown[]) => api(...args),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
  apiErrorCode: (error: { body?: unknown; code?: unknown }) => {
    if (typeof error?.code === "string") return error.code;
    if (!error?.body || typeof error.body !== "object") return null;
    const code = (error.body as { error?: unknown }).error;
    return typeof code === "string" ? code : null;
  },
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { ApiError } = await import("@/lib/api");
const { SequenceEditor } = await import("./SequenceEditor");

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/guides/resource-1"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/guides/:id" element={<SequenceEditor />} />
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
    if (
      path === "/presentation-categories" ||
      path === "/resources/resource-1/presentation"
    ) {
      return Promise.reject(
        new ApiError(
          403,
          { error: "guide_cover_authoring_disabled" },
          "Cover authoring is disabled",
        ),
      );
    }
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

afterEach(cleanup);

describe("SequenceEditor local drafts", () => {
  it("does not overwrite an in-progress guide name when its query refetches", async () => {
    const user = userEvent.setup();
    const client = renderEditor();
    const name = await screen.findByPlaceholderText("Guide name");

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
    expect(await screen.findByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
    expect(firstMessage().patchCalls()).toHaveLength(0);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["resource-messages", "resource-1"] });
    });
    await waitFor(() => expect(messageReads).toBe(2));
    expect(firstMessage().body()).toHaveValue(tooLong);
  });

  it("does not let a prior save error mask an over-limit draft's attention state", async () => {
    const user = userEvent.setup();
    patchErrorCode = "temporary_save_error";
    renderEditor();
    const body = await screen.findByPlaceholderText("What you want them to read.");

    await user.clear(body);
    await user.paste("A valid draft that cannot save yet.");
    fireEvent.blur(body);
    await screen.findByText("Couldn't save — retry");

    await user.clear(body);
    await user.paste("a".repeat(1_001));

    expect(await screen.findByText("Needs attention — message too long")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't save — retry")).not.toBeInTheDocument();
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

// Adding a step is a create, so it carries a client UUID. The order is assigned by
// the server, which is why a replay of the same UUID must not append twice.
describe("SequenceEditor add step identity", () => {
  function addCalls() {
    return api.mock.calls.filter(([p]) => String(p) === "/messages");
  }

  function lastAddCall() {
    return addCalls().at(-1)?.[1] as { operationId?: string; body?: string } | undefined;
  }

  it("sends one UUID as both the step id and the idempotency key", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByRole("button", { name: "Text" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Text" }));

    await waitFor(() => expect(lastAddCall()).toBeDefined());
    const options = lastAddCall()!;
    const body = JSON.parse(String(options.body));
    expect(body.id).toBe(options.operationId);
    expect(body.resourceId).toBe("resource-1");
    // The server owns the position; the request must not claim one.
    expect(body).not.toHaveProperty("order");
  });

  it("repeats the same UUID after an unknown outcome", async () => {
    // The first add fails with an outcome nobody can classify.
    const failOnce = new Error("unknown outcome");
    let addAttempts = 0;
    const baseImpl = api.getMockImplementation()!;
    api.mockImplementation((path: unknown, init?: unknown) => {
      if (String(path) === "/messages") {
        addAttempts += 1;
        if (addAttempts === 1) return Promise.reject(failOnce);
        return Promise.resolve({
          id: "message-new",
          order: 2,
          type: "text",
          body: "New step — edit me.",
          mediaUrl: null,
        });
      }
      return baseImpl(path, init);
    });

    renderEditor();
    await waitFor(() => expect(screen.getByRole("button", { name: "Text" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    await waitFor(() => expect(addCalls().length).toBe(1));
    const first = lastAddCall()!.operationId;

    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    await waitFor(() => expect(addCalls().length).toBe(2));

    expect(lastAddCall()!.operationId).toBe(first);
  });
});

describe("SequenceEditor cover panel integration", () => {
  const bedtimeCategory = {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "bedtime",
    name: "Bedtime",
    collectionLabel: "SLEEP",
    defaultKicker: "A TINY WIN FOR TONIGHT",
    templateKey: "warm_editorial_corner_v1",
    paletteKey: "bedtime_blush_v1",
    illustrationKey: "bedtime_window_house_v1",
    designStatus: "ready",
    nextEditionNumber: 18,
    sortOrder: 1,
    createdBy: "creator@tinysoho.com",
    updatedBy: "creator@tinysoho.com",
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
  } as const;
  const recipesCategory = {
    ...bedtimeCategory,
    id: "10000000-0000-4000-8000-000000000002",
    slug: "recipes",
    name: "Recipes",
    collectionLabel: "RECIPES",
    defaultKicker: "A LITTLE WIN AT THE TABLE",
    paletteKey: "recipes_corner_table_v1",
    illustrationKey: "recipes_corner_bowl_v1",
    nextEditionNumber: 4,
    sortOrder: 2,
  } as const;
  const suggestedCopy = {
    headline: "A softer bedtime starts here",
    supportingLine: "Small steps for calmer family evenings.",
    closingLine: "Prepared for tonight.",
    alternativeDescription:
      "Blush TinySoho sleep guide cover with a moonlit house illustration.",
  };

  function installEnabledCoverApi() {
    const baseImpl = api.getMockImplementation()!;
    api.mockImplementation((path: unknown, init?: unknown) => {
      const route = String(path);
      if (route === "/presentation-categories") {
        return Promise.resolve({ categories: [bedtimeCategory, recipesCategory] });
      }
      if (route === "/resources/resource-1/presentation") {
        return Promise.resolve({ presentation: null, coverVersions: [] });
      }
      if (route === "/resources/resource-1/cover-suggestions") {
        return Promise.resolve({
          replayed: false,
          suggestion: { id: "40000000-0000-4000-8000-000000000001" },
          draft: {
            categoryId: bedtimeCategory.id,
            templateKey: bedtimeCategory.templateKey,
            paletteKey: bedtimeCategory.paletteKey,
            illustrationKey: bedtimeCategory.illustrationKey,
            ...suggestedCopy,
          },
        });
      }
      if (route === "/resources/resource-1/cover-versions") {
        const request = init as { body: string };
        const body = JSON.parse(request.body) as {
          id: string;
          categoryId: string;
          suggestionId: string | null;
          copy: typeof suggestedCopy;
        };
        return Promise.resolve({
          replayed: false,
          cover: {
            id: body.id,
            resourceId: "resource-1",
            revision: 1,
            status: "draft",
            renderStatus: "not_rendered",
            categoryId: body.categoryId,
            editionNumber: null,
            templateKey: bedtimeCategory.templateKey,
            paletteKey: bedtimeCategory.paletteKey,
            illustrationKey: bedtimeCategory.illustrationKey,
            kicker: bedtimeCategory.defaultKicker,
            collectionLabel: bedtimeCategory.collectionLabel,
            ...body.copy,
            suggestionId: body.suggestionId,
            contentHash: null,
            dmStoragePath: null,
            genericStoragePath: null,
            renderErrorCode: null,
            approvedBy: null,
            approvedAt: null,
            publishedBy: null,
            publishedAt: null,
            createdAt: "2026-08-22T12:00:00.000Z",
            updatedAt: "2026-08-22T12:00:00.000Z",
          },
        });
      }
      return baseImpl(path, init);
    });
  }

  it("mounts Presentation & cover after guide identity and before Steps", async () => {
    installEnabledCoverApi();
    renderEditor();

    expect(
      await screen.findByRole("region", { name: "Presentation and cover" }),
    ).toBeInTheDocument();
    const coverHeading = await screen.findByText("Presentation & cover");
    expect(
      coverHeading.compareDocumentPosition(screen.getByText("Steps")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps cover actions isolated from the message API and query cache", async () => {
    installEnabledCoverApi();
    const user = userEvent.setup();
    const client = renderEditor();
    await screen.findByRole("region", { name: "Presentation and cover" });

    const messageQueryUpdates: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        JSON.stringify(event.query.queryKey) ===
          JSON.stringify(["resource-messages", "resource-1"])
      ) {
        messageQueryUpdates.push(event.action.type);
      }
    });

    await user.click(await screen.findByText("Recipes"));
    await user.click(screen.getByRole("button", { name: "Suggest from guide" }));
    const headline = await screen.findByLabelText("Cover headline");
    await waitFor(() => expect(headline).toHaveValue(suggestedCopy.headline));
    await user.clear(headline);
    await user.type(headline, "A calmer bedtime begins here");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));
    await screen.findByText("Draft saved");
    unsubscribe();

    expect(
      api.mock.calls.filter(
        ([path, request]) =>
          String(path).startsWith("/messages") &&
          typeof request === "object" &&
          request !== null &&
          "method" in request,
      ),
    ).toHaveLength(0);
    expect(messageReads).toBe(1);
    expect(messageQueryUpdates).toEqual([]);
  });
});
