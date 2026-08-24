import { describe, expect, it, vi } from "vitest";

import { createGuideCoverRepository } from "./guideCoverRepository.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T12:00:00.000Z");
const copy = {
  kicker: "A TINY WIN FOR TONIGHT",
  collectionLabel: "SLEEP",
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A TinySoho bedtime guide cover.",
};
const draft = {
  id: COVER_ID,
  resourceId: RESOURCE_ID,
  revision: 1,
  status: "draft" as const,
  renderStatus: "not_rendered" as const,
  categoryId: CATEGORY_ID,
  editionNumber: null,
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  ...copy,
  suggestionId: null,
  contentHash: null,
  dmStoragePath: null,
  genericStoragePath: null,
  renderErrorCode: null,
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function database() {
  const value = {
    $queryRaw: vi.fn(),
    resourcePresentation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    resourceCoverVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  value.$transaction.mockImplementation(async (operation: (tx: typeof value) => unknown) =>
    operation(value),
  );
  return value;
}

describe("guide cover repository", () => {
  it("creates or exactly replays a presentation assignment", async () => {
    const db = database();
    const presentation = {
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      editionNumber: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    db.resourcePresentation.create.mockRejectedValue({ code: "P2002" });
    db.resourcePresentation.findUnique.mockResolvedValue(presentation);
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.createOrLoadPresentation({ resourceId: RESOURCE_ID, categoryId: CATEGORY_ID }),
    ).resolves.toEqual({ ok: true, value: presentation, replayed: true });
  });

  it("replays the same assignment after its backend-owned edition was allocated", async () => {
    const db = database();
    const presentation = {
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      editionNumber: 17,
      createdAt: NOW,
      updatedAt: NOW,
    };
    db.resourcePresentation.create.mockRejectedValue({ code: "P2002" });
    db.resourcePresentation.findUnique.mockResolvedValue(presentation);
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.createOrLoadPresentation({ resourceId: RESOURCE_ID, categoryId: CATEGORY_ID }),
    ).resolves.toEqual({ ok: true, value: presentation, replayed: true });
  });

  it("creates or exactly replays a UUID-owned draft", async () => {
    const db = database();
    db.resourceCoverVersion.create.mockRejectedValue({ code: "P2002" });
    db.resourceCoverVersion.findUnique.mockResolvedValue(draft);
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.createOrLoadDraft({
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        categoryId: CATEGORY_ID,
        templateKey: draft.templateKey,
        paletteKey: draft.paletteKey,
        illustrationKey: draft.illustrationKey,
        suggestionId: null,
        copy,
      }),
    ).resolves.toEqual({ ok: true, value: draft, replayed: true });
  });

  it("allocates the next resource revision under the presentation lock", async () => {
    const db = database();
    db.resourceCoverVersion.findUnique.mockResolvedValue(null);
    db.resourcePresentation.findUnique.mockResolvedValue({
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      editionNumber: 1,
    });
    db.$queryRaw
      .mockResolvedValueOnce([{ id: RESOURCE_ID }])
      .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
      .mockResolvedValueOnce([{ revision: 4 }]);
    db.resourceCoverVersion.create.mockResolvedValue({ ...draft, revision: 4 });
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.createOrLoadDraft({
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        categoryId: CATEGORY_ID,
        templateKey: draft.templateKey,
        paletteKey: draft.paletteKey,
        illustrationKey: draft.illustrationKey,
        suggestionId: null,
        copy,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false, value: { revision: 4 } });

    expect(db.resourceCoverVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: COVER_ID, revision: 4 }),
    });
  });

  it("increments the draft revision behind an optimistic fence", async () => {
    const db = database();
    db.$queryRaw
      .mockResolvedValueOnce([{ id: RESOURCE_ID }])
      .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
      .mockResolvedValueOnce([{ id: COVER_ID }])
      .mockResolvedValueOnce([{ revision: 4 }]);
    db.resourceCoverVersion.updateMany.mockResolvedValue({ count: 1 });
    db.resourceCoverVersion.findUnique
      .mockResolvedValueOnce({ ...draft, revision: 1 })
      .mockResolvedValueOnce({ ...draft, revision: 4 });
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.saveDraft({
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 1,
        copy: { ...copy, headline: "A gentler bedtime" },
      }),
    ).resolves.toMatchObject({ ok: true, value: { revision: 4 } });
    expect(db.resourceCoverVersion.updateMany).toHaveBeenCalledWith({
      where: {
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        revision: 1,
        status: "draft",
      },
      data: expect.objectContaining({ revision: 4, headline: "A gentler bedtime" }),
    });
  });

  it("returns a stable conflict when the draft fence loses", async () => {
    const db = database();
    db.$queryRaw
      .mockResolvedValueOnce([{ id: RESOURCE_ID }])
      .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
      .mockResolvedValueOnce([{ id: COVER_ID }]);
    db.resourceCoverVersion.findUnique.mockResolvedValue({ ...draft, revision: 2 });
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.saveDraft({
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 1,
        copy,
      }),
    ).resolves.toEqual({ ok: false, error: "cover_revision_conflict" });
  });

  it("loads only a fully rendered published cover", async () => {
    const db = database();
    const published = {
      ...draft,
      status: "published",
      renderStatus: "ready",
      contentHash: "a".repeat(64),
      dmStoragePath: "guide-cover/path/dm.png",
    };
    db.resourceCoverVersion.findFirst.mockResolvedValue(published);
    const repository = createGuideCoverRepository({ database: db });

    await expect(repository.findPublished(RESOURCE_ID)).resolves.toBe(published);
    expect(db.resourceCoverVersion.findFirst).toHaveBeenCalledWith({
      where: {
        resourceId: RESOURCE_ID,
        status: "published",
        renderStatus: "ready",
        contentHash: { not: null },
        dmStoragePath: { not: null },
      },
    });
  });
});

describe("changing the collection of a guide that is not published", () => {
  const OTHER_CATEGORY_ID = "10000000-0000-4000-8000-000000000002";

  function repointable(editionNumber: number | null) {
    const db = database();
    db.resourceCoverVersion.findUnique.mockResolvedValue(null);
    db.resourcePresentation.findUnique.mockResolvedValue({
      resourceId: RESOURCE_ID,
      categoryId: OTHER_CATEGORY_ID,
      editionNumber,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.$queryRaw
      .mockResolvedValueOnce([{ id: RESOURCE_ID }])
      .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
      .mockResolvedValueOnce([{ revision: 2 }]);
    db.resourcePresentation.updateMany.mockResolvedValue({ count: 1 });
    db.resourceCoverVersion.updateMany.mockResolvedValue({ count: 1 });
    db.resourceCoverVersion.findFirst.mockResolvedValue(null);
    db.resourceCoverVersion.create.mockResolvedValue({ ...draft, revision: 2 });
    return db;
  }

  function createDraftIn(repository: ReturnType<typeof createGuideCoverRepository>) {
    return repository.createOrLoadDraft({
      id: COVER_ID,
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      templateKey: draft.templateKey,
      paletteKey: draft.paletteKey,
      illustrationKey: draft.illustrationKey,
      suggestionId: null,
      copy,
    });
  }

  it("moves the presentation and retires what the old collection left behind", async () => {
    const db = repointable(null);

    await expect(
      createDraftIn(createGuideCoverRepository({ database: db })),
    ).resolves.toMatchObject({ ok: true, replayed: false, value: { revision: 2 } });

    // Compare-and-swap on a null edition: a publication that wins the race takes the row.
    expect(db.resourcePresentation.updateMany).toHaveBeenCalledWith({
      where: {
        resourceId: RESOURCE_ID,
        categoryId: OTHER_CATEGORY_ID,
        editionNumber: null,
      },
      data: { categoryId: CATEGORY_ID },
    });
    // The old collection's drafts carry its kicker, label and visual keys and can never be
    // published from here, so they are retired rather than left as the working cover.
    expect(db.resourceCoverVersion.updateMany).toHaveBeenCalledWith({
      where: {
        resourceId: RESOURCE_ID,
        categoryId: OTHER_CATEGORY_ID,
        status: { in: ["draft", "approved"] },
      },
      data: { status: "retired" },
    });
  });

  it("refuses once an edition has been allocated, and writes nothing", async () => {
    const db = repointable(7);

    await expect(
      createDraftIn(createGuideCoverRepository({ database: db })),
    ).resolves.toEqual({ ok: false, error: "cover_category_locked_by_publication" });

    expect(db.resourcePresentation.updateMany).not.toHaveBeenCalled();
    expect(db.resourceCoverVersion.updateMany).not.toHaveBeenCalled();
    expect(db.resourceCoverVersion.create).not.toHaveBeenCalled();
  });

  it("refuses while a published cover exists even with no edition on the row", async () => {
    const db = repointable(null);
    db.resourceCoverVersion.findFirst.mockResolvedValue({ id: COVER_ID });

    await expect(
      createDraftIn(createGuideCoverRepository({ database: db })),
    ).resolves.toEqual({ ok: false, error: "cover_category_locked_by_publication" });

    expect(db.resourcePresentation.updateMany).not.toHaveBeenCalled();
    expect(db.resourceCoverVersion.create).not.toHaveBeenCalled();
  });

  it("retires nothing when the compare-and-swap loses the row", async () => {
    const db = repointable(null);
    db.resourcePresentation.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      createDraftIn(createGuideCoverRepository({ database: db })),
    ).resolves.toEqual({ ok: false, error: "cover_create_conflict" });

    expect(db.resourceCoverVersion.updateMany).not.toHaveBeenCalled();
    expect(db.resourceCoverVersion.create).not.toHaveBeenCalled();
  });

  it("loads a presentation that names another collection instead of failing early", async () => {
    const db = database();
    const stored = {
      resourceId: RESOURCE_ID,
      categoryId: OTHER_CATEGORY_ID,
      editionNumber: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    db.resourcePresentation.create.mockRejectedValue({ code: "P2002" });
    db.resourcePresentation.findUnique.mockResolvedValue(stored);
    const repository = createGuideCoverRepository({ database: db });

    // Not a replay of this intent, but not a failure either: whether the guide may move
    // is decided under the presentation lock, not here.
    await expect(
      repository.createOrLoadPresentation({ resourceId: RESOURCE_ID, categoryId: CATEGORY_ID }),
    ).resolves.toEqual({ ok: true, value: stored, replayed: false });
  });

  it("moves a guide on its own for callers that write no cover revision", async () => {
    const db = repointable(null);
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.repointPresentation({
        resourceId: RESOURCE_ID,
        toCategoryId: CATEGORY_ID,
      }),
    ).resolves.toEqual({ ok: true, outcome: "moved" });
  });
});
