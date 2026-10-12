// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaContext } from "./KeywordForm";
import type { Resource } from "@/lib/types";

const api = vi.fn();
const apiMutation = vi.fn();

vi.mock("@/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiRead: (path: unknown) => api(path),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { KeywordForm } = await import("./KeywordForm");

const MEDIA: MediaContext = {
  mediaId: "media-1",
  kind: "reel",
  caption: "Sleep reel",
  permalink: "https://instagram.com/p/x",
  thumbnailUrl: null,
  postedAt: "2026-08-16T09:00:00+0000",
};

function renderForm(resources: Resource[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <KeywordForm initial={null} resources={resources} onClose={vi.fn()} mediaContext={MEDIA} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// "new sequence" mode is the default, so this is the label the submit carries.
const SUBMIT = "Create & add steps";

function callsTo(path: string) {
  return apiMutation.mock.calls.filter(([p]) => String(p) === path);
}

function bodyOf(call: unknown[]) {
  return JSON.parse(String((call[1] as { body?: string }).body));
}

beforeEach(() => {
  api.mockReset().mockResolvedValue([]);
  apiMutation.mockReset();
});

afterEach(cleanup);

/**
 * Creating a keyword with a new sequence is two creates in one attempt. That makes
 * it the case where a naive retry does real damage: the sequence already exists,
 * and asking again without the original key would leave a duplicate behind.
 */
describe("KeywordForm create identity", () => {
  async function fillAndSubmit() {
    const user = userEvent.setup();
    renderForm();
    // The form's labels are not associated with their controls, so placeholders
    // are the stable handle here.
    await waitFor(() => expect(screen.getByPlaceholderText("RECIPE")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "SLEEP" } });
    fireEvent.change(screen.getByPlaceholderText("Toddler Activity Guide"), {
      target: { value: "Sleep guide" },
    });
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    return user;
  }

  it("keys both creates and reuses the keyword id as its row id", async () => {
    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources"
          ? { id: "will-be-ignored" }
          : { id: "kw-1", resourceId: "res-1" },
      ),
    );

    await fillAndSubmit();

    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    const resourceCall = callsTo("/resources")[0];
    const keywordCall = callsTo("/keywords")[0];

    for (const call of [resourceCall, keywordCall]) {
      const options = call[1] as { operationId?: string };
      expect(bodyOf(call).id).toBe(options.operationId);
      expect(options.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    // Two creates, two distinct identities.
    expect(bodyOf(resourceCall).id).not.toBe(bodyOf(keywordCall).id);
  });

  it("reuses the sequence's UUID when only the keyword create failed", async () => {
    // First attempt: the sequence lands, the keyword does not.
    apiMutation.mockImplementation((path: string) =>
      String(path) === "/resources"
        ? Promise.resolve({ id: "res-1" })
        : Promise.reject(new Error("unknown outcome")),
    );

    const user = await fillAndSubmit();
    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    const firstSequenceId = bodyOf(callsTo("/resources")[0]).id;

    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources" ? { id: "res-1" } : { id: "kw-1", resourceId: "res-1" },
      ),
    );
    await user.click(screen.getByRole("button", { name: SUBMIT }));
    await waitFor(() => expect(callsTo("/keywords").length).toBe(2));

    // The sequence exists. Repeating its original UUID replays it; a fresh one
    // would have left a second sequence behind.
    expect(bodyOf(callsTo("/resources")[1]).id).toBe(firstSequenceId);
  });

  it("issues fresh identities only after a confirmed success", async () => {
    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources" ? { id: "res-1" } : { id: "kw-1", resourceId: "res-1" },
      ),
    );

    await fillAndSubmit();
    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    const firstKeywordId = bodyOf(callsTo("/keywords")[0]).id;

    // The form stays mounted in this test, so a second submit is a new intent.
    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "WAKE" } });
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    await waitFor(() => expect(callsTo("/keywords").length).toBe(2));

    expect(bodyOf(callsTo("/keywords")[1]).id).not.toBe(firstKeywordId);
  });

  it("starts a new keyword with the approved public reply", async () => {
    renderForm();

    expect(
      await screen.findByDisplayValue("It’s waiting for you 💛 Check your DMs (and Requests)!"),
    ).toBeInTheDocument();
  });

  it("allows a two-word keyword phrase", async () => {
    const user = userEvent.setup();
    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources"
          ? { id: "res-1" }
          : { id: "kw-1", resourceId: "res-1" },
      ),
    );
    renderForm();

    fireEvent.change(await screen.findByPlaceholderText("RECIPE"), {
      target: { value: "HIGH CHAIR" },
    });
    fireEvent.change(screen.getByPlaceholderText("Toddler Activity Guide"), {
      target: { value: "High Chair Guide" },
    });
    await user.click(screen.getByRole("button", { name: SUBMIT }));

    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    expect(bodyOf(callsTo("/keywords")[0]!).keyword).toBe("HIGH CHAIR");
  });

  it("blocks a phrase with more than two words", async () => {
    renderForm();

    fireEvent.change(await screen.findByPlaceholderText("RECIPE"), {
      target: { value: "HIGH CHAIR GUIDE" },
    });
    fireEvent.change(screen.getByPlaceholderText("Toddler Activity Guide"), {
      target: { value: "High Chair Guide" },
    });

    expect(screen.getByRole("button", { name: SUBMIT })).toBeDisabled();
  });
});

describe("KeywordForm link guides", () => {
  const URL_PLACEHOLDER = "https://mycuratedhaven.com/halloween";

  async function chooseLink() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Link to a page/ }));
    return user;
  }

  it("creates a link guide and its keyword, with no gate message field", async () => {
    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources" ? { id: "res-link" } : { id: "kw-1", resourceId: "res-link" },
      ),
    );
    renderForm();
    const user = await chooseLink();

    expect(screen.queryByPlaceholderText("Reply DONE and I'll send your guide!")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "GHOST" } });
    fireEvent.change(screen.getByPlaceholderText("Halloween collection"), {
      target: { value: "Halloween collection" },
    });
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), {
      target: { value: "https://mycuratedhaven.com/halloween" },
    });
    await user.click(screen.getByRole("button", { name: "Create keyword" }));

    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    expect(bodyOf(callsTo("/resources")[0]!)).toMatchObject({
      name: "Halloween collection",
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    });
    expect(bodyOf(callsTo("/keywords")[0]!)).toMatchObject({
      keyword: "GHOST",
      resourceId: "res-link",
      publicReply: "Sent you the recipes 💛 Check your DMs (and Requests)!",
    });
  });

  it("blocks a link that is not https", async () => {
    renderForm();
    await chooseLink();
    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "GHOST" } });
    fireEvent.change(screen.getByPlaceholderText("Halloween collection"), {
      target: { value: "Halloween collection" },
    });
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), {
      target: { value: "http://mycuratedhaven.com/halloween" },
    });

    expect(screen.getByRole("button", { name: "Create keyword" })).toBeDisabled();
  });

  it("only offers link guides once Link is chosen", async () => {
    const createdAt = "2026-10-01T00:00:00.000Z";
    renderForm([
      { id: "g1", name: "Sleep guide", description: null, createdAt, deliveryMode: "gated" },
      { id: "l1", name: "Halloween collection", description: null, createdAt, deliveryMode: "link" },
    ]);
    const user = await chooseLink();
    await user.click(screen.getByRole("button", { name: /Use existing/ }));

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options.some((text) => text?.includes("Halloween collection"))).toBe(true);
    expect(options.some((text) => text?.includes("Sleep guide"))).toBe(false);
  });
});
