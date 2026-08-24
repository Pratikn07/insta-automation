// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { MutationOutcomeUnknownError } from "@/lib/mutationOutcome";

import { GuideCoverPanel } from "./GuideCoverPanel";
import type {
  PresentationCategory,
  ResourceCoverVersion,
  ResourcePresentationResponse,
} from "./types";

const apiRead = vi.fn();
const apiMutation = vi.fn();

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiRead: (...args: unknown[]) => apiRead(...args),
    apiMutation: (...args: unknown[]) => apiMutation(...args),
  };
});

const RESOURCE_ID = "resource-1";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_CATEGORY_ID = "10000000-0000-4000-8000-000000000002";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const SUGGESTION_ID = "40000000-0000-4000-8000-000000000001";

const category: PresentationCategory = {
  id: CATEGORY_ID,
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
};

const secondCategory: PresentationCategory = {
  ...category,
  id: SECOND_CATEGORY_ID,
  slug: "big-feelings",
  name: "Big Feelings",
  collectionLabel: "FEELINGS",
  defaultKicker: "A TINY WIN FOR RIGHT NOW",
  nextEditionNumber: 7,
  sortOrder: 2,
};

const inactiveCategory: PresentationCategory = {
  ...category,
  id: "10000000-0000-4000-8000-000000000009",
  slug: "archive",
  name: "Archive",
  collectionLabel: "ARCHIVE",
  defaultKicker: "A TINY WIN FROM BEFORE",
  designStatus: "inactive",
  nextEditionNumber: 3,
  sortOrder: null,
};

const defaultCopy = {
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription:
    "Blush TinySoho sleep guide cover with a moonlit house illustration.",
};

function cover(overrides: Partial<ResourceCoverVersion> = {}): ResourceCoverVersion {
  return {
    id: COVER_ID,
    resourceId: RESOURCE_ID,
    revision: 1,
    status: "draft",
    renderStatus: "not_rendered",
    categoryId: CATEGORY_ID,
    editionNumber: null,
    templateKey: category.templateKey,
    paletteKey: category.paletteKey,
    illustrationKey: category.illustrationKey,
    kicker: category.defaultKicker,
    collectionLabel: category.collectionLabel,
    ...defaultCopy,
    suggestionId: null,
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
    ...overrides,
  };
}

function presentation(
  overrides: Partial<ResourcePresentationResponse> = {},
): ResourcePresentationResponse {
  return {
    presentation: null,
    coverVersions: [],
    ...overrides,
  };
}

function presentationWithCover(
  workingCover = cover(),
): ResourcePresentationResponse {
  return presentation({
    presentation: {
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      editionNumber: null,
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
    },
    coverVersions: [workingCover],
  });
}

function presentationWithInactiveCurrent(
  workingCover = cover({ categoryId: inactiveCategory.id }),
): ResourcePresentationResponse {
  return presentation({
    presentation: {
      resourceId: RESOURCE_ID,
      categoryId: inactiveCategory.id,
      editionNumber: workingCover.editionNumber,
      category: inactiveCategory,
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
    },
    coverVersions: [workingCover],
  });
}

function installSuccessfulReads(
  response = presentation(),
  categories: PresentationCategory[] = [category],
) {
  apiRead.mockImplementation((path: string) => {
    if (path === "/presentation-categories") {
      return Promise.resolve({ categories });
    }
    if (path === `/resources/${RESOURCE_ID}/presentation`) {
      return Promise.resolve(response);
    }
    throw new Error(`Unexpected read: ${path}`);
  });
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <GuideCoverPanel resourceId={RESOURCE_ID} resourceName="Toddler sleep guide" />
      </QueryClientProvider>,
    ),
  };
}

function mutationFor(path: string) {
  return apiMutation.mock.calls.find(([calledPath]) => calledPath === path) as
    | [string, { method: string; body: string; operationId?: string }]
    | undefined;
}

beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset();

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  const canvasContext = {
    font: "",
    measureText(text: string) {
      const fontSize = Number(/([\d.]+)px/u.exec(this.font)?.[1] ?? 16);
      return { width: [...text].length * fontSize * 0.5 };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GuideCoverPanel reads and local editing", () => {
  it("hides the whole panel only when cover authoring is disabled", async () => {
    apiRead.mockRejectedValue(
      new ApiError(403, { error: "guide_cover_authoring_disabled" }, "disabled"),
    );

    renderPanel();

    await waitFor(() => expect(apiRead).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Presentation and cover" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the suggestion UUID stable until a suggestion is known to succeed", async () => {
    installSuccessfulReads();
    apiMutation
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-suggestions`,
          SUGGESTION_ID,
        ),
      )
      .mockResolvedValueOnce({
        replayed: true,
        suggestion: { id: SUGGESTION_ID },
        draft: {
          categoryId: CATEGORY_ID,
          templateKey: category.templateKey,
          paletteKey: category.paletteKey,
          illustrationKey: category.illustrationKey,
          ...defaultCopy,
        },
      });
    const user = userEvent.setup();

    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Suggest from guide" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Suggest from guide" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));

    const first = apiMutation.mock.calls[0]?.[1] as { body: string; operationId: string };
    const retry = apiMutation.mock.calls[1]?.[1] as { body: string; operationId: string };
    expect(retry.operationId).toBe(first.operationId);
    expect(JSON.parse(first.body).id).toBe(first.operationId);
    expect(JSON.parse(retry.body).id).toBe(first.operationId);
  });

  it("shows a retry for an ordinary read failure", async () => {
    let categoryAttempts = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        categoryAttempts += 1;
        return categoryAttempts === 1
          ? Promise.reject(new Error("network down"))
          : Promise.resolve({ categories: [category] });
      }
      return Promise.resolve(presentation());
    });
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Retry cover editor" }));
    expect(await screen.findByRole("button", { name: "Suggest from guide" })).toBeEnabled();
    expect(categoryAttempts).toBe(2);
  });

  it("shows retry when a non-403 response reuses the disabled error code", async () => {
    apiRead.mockImplementation((path: string) =>
      path === "/presentation-categories"
        ? Promise.reject(
            new ApiError(
              500,
              { error: "guide_cover_authoring_disabled" },
              "misleading upstream response",
            ),
          )
        : Promise.resolve(presentation()),
    );

    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Retry cover editor" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Presentation and cover" })).toBeVisible();
  });

  it("applies a suggestion only to editable local category and copy", async () => {
    installSuccessfulReads();
    apiMutation.mockResolvedValue({
      replayed: false,
      suggestion: { id: SUGGESTION_ID },
      draft: {
        categoryId: CATEGORY_ID,
        templateKey: category.templateKey,
        paletteKey: category.paletteKey,
        illustrationKey: category.illustrationKey,
        headline: "Bedtime can feel softer",
        supportingLine: "A gentler wind-down for the whole family.",
        closingLine: "Prepared for calmer evenings.",
        alternativeDescription: "A soft blush bedtime guide cover.",
      },
    });
    const user = userEvent.setup();

    const { container } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Suggest from guide" }));

    expect(screen.getByLabelText("Cover headline")).toHaveValue("Bedtime can feel softer");
    expect(screen.getByLabelText("Supporting line")).toHaveValue(
      "A gentler wind-down for the whole family.",
    );
    await waitFor(() =>
      expect(container.querySelector(".guide-cover-preview svg")?.innerHTML).toContain(
        "A gentler wind-down for the",
      ),
    );

    expect(apiMutation).toHaveBeenCalledTimes(1);
    const [path, request] = apiMutation.mock.calls[0] as [
      string,
      { method: string; body: string; operationId: string },
    ];
    expect(path).toBe(`/resources/${RESOURCE_ID}/cover-suggestions`);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({
      id: request.operationId,
      selectedCategoryId: CATEGORY_ID,
    });
    expect(apiMutation.mock.calls.some(([calledPath]) => /approve|publish/u.test(calledPath))).toBe(
      false,
    );
  });

  it("never saves cover fields on blur and creates a UUID-owned draft explicitly", async () => {
    installSuccessfulReads();
    apiMutation.mockResolvedValue({ cover: cover(), replayed: false });
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My local headline");
    await user.tab();

    expect(apiMutation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save cover draft" }));
    await waitFor(() =>
      expect(mutationFor(`/resources/${RESOURCE_ID}/cover-versions`)).toBeDefined(),
    );

    const [, request] = mutationFor(`/resources/${RESOURCE_ID}/cover-versions`)!;
    const body = JSON.parse(request.body) as {
      id: string;
      categoryId: string;
      copy: { headline: string };
    };
    expect(request.method).toBe("POST");
    expect(body.id).toBe(request.operationId);
    expect(body.categoryId).toBe(CATEGORY_ID);
    expect(body.copy.headline).toBe("My local headline");
    expect(await screen.findByText("Draft")).toBeVisible();
  });

  it("enforces cover limits by Unicode code point at an emoji boundary", async () => {
    installSuccessfulReads();
    const user = userEvent.setup();
    const validHeadline = `${"a".repeat(55)}😀`;

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, validHeadline);

    expect(headline).toHaveValue(validHeadline);
    expect(screen.getByText("56 / 56")).toBeVisible();

    await user.type(headline, "b");
    expect(headline).toHaveValue(validHeadline);
  });
});

describe("GuideCoverPanel draft persistence and recovery", () => {
  it("locks editable cover intent while an explicit save is in flight", async () => {
    installSuccessfulReads();
    let finishSave!: (value: { cover: ResourceCoverVersion; replayed: boolean }) => void;
    apiMutation.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const user = userEvent.setup();

    renderPanel();
    const save = await screen.findByRole("button", { name: "Save cover draft" });
    await user.click(save);

    expect(screen.getByRole("region", { name: "Presentation and cover" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByLabelText("Cover headline")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Presentation category" })).toBeDisabled();

    finishSave({ cover: cover(), replayed: false });
    expect(await screen.findByText("Draft saved")).toBeVisible();
  });

  it("patches a saved draft with its optimistic revision only after explicit save", async () => {
    installSuccessfulReads(presentationWithCover());
    apiMutation.mockResolvedValue({
      cover: cover({ revision: 2, headline: "My revised headline" }),
    });
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My revised headline");
    await user.tab();
    expect(apiMutation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save cover draft" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));

    const [path, request] = apiMutation.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(path).toBe(`/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}`);
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body)).toEqual({
      expectedRevision: 1,
      copy: { ...defaultCopy, headline: "My revised headline" },
    });
  });

  it("creates a new UUID-owned draft when the category of an existing draft changes", async () => {
    installSuccessfulReads(presentationWithCover(), [category, secondCategory]);
    apiMutation.mockResolvedValue({
      cover: cover({
        id: "30000000-0000-4000-8000-000000000002",
        categoryId: SECOND_CATEGORY_ID,
        headline: "Keep my local copy",
      }),
      replayed: false,
    });
    const user = userEvent.setup();

    renderPanel();
    await screen.findByText("Big Feelings");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Presentation category" }),
      SECOND_CATEGORY_ID,
    );
    const headline = screen.getByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "Keep my local copy");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));

    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));
    const [path, request] = apiMutation.mock.calls[0] as [
      string,
      { method: string; operationId?: string; body: string },
    ];
    expect(path).toBe(`/resources/${RESOURCE_ID}/cover-versions`);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toMatchObject({
      id: request.operationId,
      categoryId: SECOND_CATEGORY_ID,
      copy: { headline: "Keep my local copy" },
    });
    expect(
      apiMutation.mock.calls.some(([calledPath, options]) =>
        calledPath === `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}` &&
        options.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("replays an uncertain create with the same client-owned UUID", async () => {
    installSuccessfulReads();
    apiMutation
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(`/resources/${RESOURCE_ID}/cover-versions`, undefined),
      )
      .mockResolvedValueOnce({ cover: cover(), replayed: true });
    const user = userEvent.setup();

    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Save cover draft" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry draft creation" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));

    const first = apiMutation.mock.calls[0]?.[1] as { body: string; operationId: string };
    const retry = apiMutation.mock.calls[1]?.[1] as { body: string; operationId: string };
    expect(retry.operationId).toBe(first.operationId);
    expect(JSON.parse(first.body).id).toBe(first.operationId);
    expect(JSON.parse(retry.body).id).toBe(first.operationId);
  });

  it("replays the exact uncertain create intent while preserving later local edits", async () => {
    installSuccessfulReads();
    apiMutation
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(`/resources/${RESOURCE_ID}/cover-versions`, undefined),
      )
      .mockResolvedValueOnce({ cover: cover(), replayed: true });
    const user = userEvent.setup();

    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Save cover draft" }));
    await screen.findByRole("alert");

    const headline = screen.getByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "A newer local edit");
    await user.click(screen.getByRole("button", { name: "Retry draft creation" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));

    const first = apiMutation.mock.calls[0]?.[1] as { body: string; operationId: string };
    const retry = apiMutation.mock.calls[1]?.[1] as { body: string; operationId: string };
    expect(retry.operationId).toBe(first.operationId);
    expect(JSON.parse(retry.body)).toEqual(JSON.parse(first.body));
    expect(screen.getByLabelText("Cover headline")).toHaveValue("A newer local edit");
    expect(screen.getByRole("button", { name: "Save cover draft" })).toBeEnabled();
  });

  it("treats an unknown PATCH as saved when canonical state matches the intended copy", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(
          presentationWithCover(
            presentationReads === 1
              ? cover()
              : cover({ revision: 2, headline: "My intended copy" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation.mockRejectedValue(
      new MutationOutcomeUnknownError(
        `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}`,
        undefined,
      ),
    );
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My intended copy");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));

    expect(await screen.findByText("Draft saved")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save cover draft" })).toBeDisabled();
    expect(presentationReads).toBe(2);
  });

  it("allows a safe PATCH retry only after canonical state proves the row unchanged", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(presentationWithCover());
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}`,
          undefined,
        ),
      )
      .mockResolvedValueOnce({
        cover: cover({ revision: 2, headline: "My intended copy" }),
      });
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My intended copy");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));

    expect(await screen.findByText(/server draft is unchanged/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));
    expect(presentationReads).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(apiMutation.mock.calls[1]?.[1].body)).toEqual({
      expectedRevision: 1,
      copy: { ...defaultCopy, headline: "My intended copy" },
    });
  });

  it("blocks another PATCH when reconciliation GET fails until a fresh check succeeds", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        if (presentationReads === 2) return Promise.reject(new Error("read failed"));
        return Promise.resolve(
          presentationWithCover(
            presentationReads === 1
              ? cover()
              : cover({ revision: 2, headline: "My intended copy" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation.mockRejectedValue(
      new MutationOutcomeUnknownError(
        `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}`,
        undefined,
      ),
    );
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My intended copy");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));

    expect(await screen.findByText(/still confirming whether the draft save went through/i))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Save cover draft" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check save status" }));

    expect(await screen.findByText("Draft saved")).toBeVisible();
    expect(apiMutation).toHaveBeenCalledTimes(1);
    expect(presentationReads).toBe(3);
  });

  it("preserves all local copy and moves the next save to a new draft after conflict", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(
          presentationWithCover(
            presentationReads === 1
              ? cover()
              : cover({ revision: 2, headline: "Their newer headline" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation.mockRejectedValueOnce(
      new ApiError(409, { error: "cover_revision_conflict" }, "conflict"),
    );
    const user = userEvent.setup();

    renderPanel();
    const headline = await screen.findByLabelText("Cover headline");
    await user.clear(headline);
    await user.type(headline, "My local headline");
    await user.click(screen.getByRole("button", { name: "Save cover draft" }));

    expect(await screen.findByText(/newer version exists/i)).toBeVisible();
    expect(screen.getByLabelText("Cover headline")).toHaveValue("My local headline");
    expect(screen.getByLabelText("Supporting line")).toHaveValue(defaultCopy.supportingLine);
    expect(screen.getByLabelText("Closing line")).toHaveValue(defaultCopy.closingLine);
    expect(screen.getByLabelText("Alternative description")).toHaveValue(
      defaultCopy.alternativeDescription,
    );
    expect(screen.getByRole("button", { name: "Save as new draft" })).toBeEnabled();
    expect(presentationReads).toBe(2);

    apiMutation.mockResolvedValueOnce({
      cover: cover({
        id: "30000000-0000-4000-8000-000000000002",
        revision: 3,
        headline: "My local headline",
      }),
      replayed: false,
    });
    await user.click(screen.getByRole("button", { name: "Save as new draft" }));
    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(2));
    const [path, request] = apiMutation.mock.calls[1] as [
      string,
      { method: string; operationId: string; body: string },
    ];
    expect(path).toBe(`/resources/${RESOURCE_ID}/cover-versions`);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body).id).toBe(request.operationId);
  });
});

describe("GuideCoverPanel approval and publication", () => {
  it("approves then publishes with the same revision and never touches messages", async () => {
    installSuccessfulReads(presentationWithCover());
    apiMutation
      .mockResolvedValueOnce({ ok: true, outcome: "approved" })
      .mockResolvedValueOnce({
        ok: true,
        outcome: "published",
        contentHash: "a".repeat(64),
        editionNumber: 18,
        path: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm.png`,
      });
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Published")).toBeVisible();
    const mutationPaths = apiMutation.mock.calls.map(([path]) => path);
    expect(mutationPaths).toEqual([
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`,
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
    ]);
    expect(apiMutation.mock.calls.map(([, request]) => JSON.parse(request.body))).toEqual([
      { expectedRevision: 1 },
      { expectedRevision: 1 },
    ]);
    expect(
      [...apiRead.mock.calls, ...apiMutation.mock.calls].some(([path]) =>
        String(path).startsWith("/messages"),
      ),
    ).toBe(false);
  });

  it("shows Approved and retries only publication when publish fails after approval", async () => {
    installSuccessfulReads(presentationWithCover());
    apiMutation
      .mockResolvedValueOnce({ ok: true, outcome: "approved" })
      .mockRejectedValueOnce(
        new ApiError(503, { error: "cover_storage_failed" }, "storage failed"),
      )
      .mockResolvedValueOnce({
        ok: true,
        outcome: "published",
        contentHash: "a".repeat(64),
        editionNumber: 18,
        path: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm.png`,
      });
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Approved")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/approved, but publication failed/i);
    await user.click(screen.getByRole("button", { name: "Retry publish" }));

    expect(await screen.findByText("Published")).toBeVisible();
    expect(apiMutation.mock.calls.map(([path]) => path)).toEqual([
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`,
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
    ]);
  });

  it("continues to publish when a canonical read confirms an unknown approval succeeded", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(
          presentationWithCover(
            cover({ status: presentationReads === 1 ? "draft" : "approved" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`,
          undefined,
        ),
      )
      .mockResolvedValueOnce({
        ok: true,
        outcome: "published",
        contentHash: "a".repeat(64),
        editionNumber: 18,
        path: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm.png`,
      });
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Published")).toBeVisible();
    expect(apiMutation.mock.calls.map(([path]) => path)).toEqual([
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`,
      `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
    ]);
    expect(presentationReads).toBeGreaterThanOrEqual(2);
  });

  it("keeps an unknown approval pending and only re-GETs while reconciliation fails", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return presentationReads === 1
          ? Promise.resolve(presentationWithCover())
          : Promise.reject(new Error("canonical read failed"));
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation.mockRejectedValueOnce(
      new MutationOutcomeUnknownError(
        `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`,
        undefined,
      ),
    );
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Confirming approval")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/approval.*still being confirmed/i);
    await user.click(screen.getByRole("button", { name: "Check approval status" }));

    await waitFor(() => expect(presentationReads).toBe(3));
    expect(apiMutation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Confirming approval")).toBeVisible();
  });

  it("shows Approved after an unknown publish is canonically still approved", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(
          presentationWithCover(
            cover({ status: presentationReads === 1 ? "draft" : "approved" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation
      .mockResolvedValueOnce({ ok: true, outcome: "approved" })
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
          undefined,
        ),
      );
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Approved")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/publication did not complete/i);
    expect(screen.getByRole("button", { name: "Retry publish" })).toBeEnabled();
    expect(presentationReads).toBe(2);
  });

  it("shows Published when canonical state confirms an unknown publish completed", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return Promise.resolve(
          presentationWithCover(
            cover({ status: presentationReads === 1 ? "draft" : "published" }),
          ),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation
      .mockResolvedValueOnce({ ok: true, outcome: "approved" })
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
          undefined,
        ),
      );
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Published")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(presentationReads).toBe(2);
  });

  it("keeps an unknown publication pending and only re-GETs while reconciliation fails", async () => {
    let presentationReads = 0;
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [category] });
      }
      if (path === `/resources/${RESOURCE_ID}/presentation`) {
        presentationReads += 1;
        return presentationReads === 1
          ? Promise.resolve(presentationWithCover())
          : Promise.reject(new Error("canonical read failed"));
      }
      throw new Error(`Unexpected read: ${path}`);
    });
    apiMutation
      .mockResolvedValueOnce({ ok: true, outcome: "approved" })
      .mockRejectedValueOnce(
        new MutationOutcomeUnknownError(
          `/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`,
          undefined,
        ),
      );
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    await user.click(publish);

    expect(await screen.findByText("Confirming publication")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/publication.*still being confirmed/i);
    await user.click(screen.getByRole("button", { name: "Check publication status" }));

    await waitFor(() => expect(presentationReads).toBe(3));
    expect(apiMutation).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Confirming publication")).toBeVisible();
  });

  it("disables publication until a saved draft has no local edits", async () => {
    installSuccessfulReads(presentationWithCover());
    const user = userEvent.setup();

    renderPanel();
    const publish = await screen.findByRole("button", { name: "Approve and publish" });
    await waitFor(() => expect(publish).toBeEnabled());

    await user.type(screen.getByLabelText("Cover headline"), " today");
    expect(publish).toBeDisabled();
    expect(apiMutation).not.toHaveBeenCalled();
  });

  it("disables publication when no saved draft exists", async () => {
    installSuccessfulReads();

    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Approve and publish" }),
    ).toBeDisabled();
  });

  it("disables publication when the selected category is not ready", async () => {
    const needsReview = { ...category, designStatus: "needs_review" as const };
    apiRead.mockImplementation((path: string) => {
      if (path === "/presentation-categories") {
        return Promise.resolve({ categories: [needsReview] });
      }
      return Promise.resolve(presentationWithCover());
    });

    renderPanel();

    // The status now rides in the option text ("… · Needs visual review") rather than a
    // standalone badge, so it is matched on the option itself.
    expect(
      await screen.findByRole("option", { name: /Needs visual review/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
  });

  it("displays the inactive current category from presentation state without falling back to an unrelated ready category", async () => {
    installSuccessfulReads(
      presentationWithInactiveCurrent(
        cover({
          status: "draft",
          categoryId: inactiveCategory.id,
          kicker: inactiveCategory.defaultKicker,
          collectionLabel: inactiveCategory.collectionLabel,
          headline: "Historical draft headline",
        }),
      ),
      [category],
    );
    const user = userEvent.setup();

    renderPanel();

    const inactiveOption = await screen.findByRole("option", { name: /Archive.*Inactive/i });
    // A native <option disabled> carries the `disabled` attribute rather than aria-disabled.
    expect(inactiveOption).toBeDisabled();
    expect(screen.getByText("A TINY WIN FROM BEFORE")).toBeVisible();
    expect(screen.getByText("ARCHIVE")).toBeVisible();
    expect(screen.getByLabelText("Cover headline")).toHaveValue("Historical draft headline");
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();

    await user.type(screen.getByLabelText("Cover headline"), " updated");

    expect(screen.getByRole("button", { name: "Save cover draft" })).toBeDisabled();
    expect(screen.queryByText("A TINY WIN FOR TONIGHT")).not.toBeInTheDocument();
  });

  it("disables publication when exact preview validation fails", async () => {
    installSuccessfulReads(
      presentationWithCover(cover({ headline: "W".repeat(40) })),
    );

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not fit on this cover/i);
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
  });

  it("disables publication when exact preview measurement is unavailable", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn().mockRejectedValue(new Error("font unavailable")) },
    });
    installSuccessfulReads(presentationWithCover());

    renderPanel();

    expect(await screen.findByText(/exact cover preview is unavailable/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
  });
});
