import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bool = vi.fn();
const createOrLoadPresentation = vi.fn();
const createOrLoadDraft = vi.fn();
const repointPresentation = vi.fn();
const saveDraft = vi.fn();
const findPublished = vi.fn();
const approve = vi.fn();
const publish = vi.fn();
const move = vi.fn();
const suggest = vi.fn();
const findCategory = vi.fn();
const findPresentation = vi.fn();
const findCovers = vi.fn();
const findCover = vi.fn();
const findSuggestion = vi.fn();
const updatePresentation = vi.fn();
const countPublished = vi.fn();

vi.mock("../services/flagService.js", () => ({ flags: { bool } }));
vi.mock("../services/guideCoverRepository.js", () => ({
  createGuideCoverRepository: () => ({
    createOrLoadPresentation,
    createOrLoadDraft,
    repointPresentation,
    saveDraft,
    findPublished,
  }),
}));
vi.mock("../services/guideCoverPublishService.js", () => ({
  createGuideCoverPublishService: () => ({ approve, publish }),
}));
vi.mock("../services/guideCoverCollectionMoveService.js", () => ({
  createGuideCoverCollectionMoveService: () => ({ move }),
}));
vi.mock("../services/guideCoverSuggestionService.js", () => ({
  createGuideCoverSuggestionService: () => ({ suggest }),
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    presentationCategory: { findFirst: findCategory },
    resourcePresentation: {
      findUnique: findPresentation,
      updateMany: updatePresentation,
    },
    resourceCoverVersion: {
      findMany: findCovers,
      findUnique: findCover,
      count: countPublished,
    },
    resourceCoverSuggestion: { findFirst: findSuggestion },
  },
}));

const { resourceCoversRouter } = await import("./resourceCovers.routes.js");

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_CATEGORY_ID = "10000000-0000-4000-8000-000000000002";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const SUGGESTION_ID = "40000000-0000-4000-8000-000000000001";

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    req.adminEmail = "creator@tinysoho.com";
    next();
  });
  value.use("/api/resources", resourceCoversRouter);
  return value;
}

const category = {
  id: CATEGORY_ID,
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready",
};

const copy = {
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A warm bedtime guide cover.",
};

beforeEach(() => {
  vi.clearAllMocks();
  bool.mockReturnValue(true);
  findCategory.mockResolvedValue(category);
  findPresentation.mockResolvedValue(null);
  findCovers.mockResolvedValue([]);
  countPublished.mockResolvedValue(0);
  findCover.mockResolvedValue({
    id: COVER_ID,
    resourceId: RESOURCE_ID,
    categoryId: CATEGORY_ID,
    status: "draft",
  });
  findSuggestion.mockResolvedValue(null);
  updatePresentation.mockResolvedValue({ count: 1 });
  findPublished.mockResolvedValue(null);
  move.mockResolvedValue({ ok: true, outcome: "moved", editionNumber: 4 });
  repointPresentation.mockResolvedValue({ ok: true, outcome: "moved" });
  suggest.mockResolvedValue({
    ok: true,
    replayed: false,
    suggestion: { id: "40000000-0000-4000-8000-000000000001" },
    draft: { categoryId: CATEGORY_ID, headline: copy.headline },
  });
  createOrLoadPresentation.mockResolvedValue({
    ok: true,
    replayed: false,
    value: { resourceId: RESOURCE_ID, categoryId: CATEGORY_ID, editionNumber: null },
  });
});

describe("resource cover API", () => {
  it("keeps the published-cover read available when authoring is switched off", async () => {
    bool.mockReturnValue(false);
    findPublished.mockResolvedValue({
      id: COVER_ID,
      resourceId: RESOURCE_ID,
      status: "published",
      renderStatus: "ready",
      dmStoragePath:
        `guide-cover/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm.png`,
      contentHash: "a".repeat(64),
    });

    const response = await request(app())
      .get(`/api/resources/${RESOURCE_ID}/published-cover`)
      .expect(200);

    expect(response.body.cover).toMatchObject({ id: COVER_ID, status: "published" });
    expect(response.body.cover.publicUrl).toContain(
      `/guide-cover/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm.png`,
    );
    expect(response.body.cover).not.toHaveProperty("approvedBy");
  });

  it("refuses every authoring mutation while the flag is off", async () => {
    bool.mockReturnValue(false);

    await request(app())
      .put(`/api/resources/${RESOURCE_ID}/presentation`)
      .send({ categoryId: CATEGORY_ID })
      .expect(403, { error: "guide_cover_authoring_disabled" });

    expect(createOrLoadPresentation).not.toHaveBeenCalled();
  });

  it("creates a bounded suggestion without approving or publishing it", async () => {
    const suggestionId = "40000000-0000-4000-8000-000000000001";
    const response = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-suggestions`)
      .set("idempotency-key", suggestionId)
      .send({ id: suggestionId, selectedCategoryId: CATEGORY_ID })
      .expect(201);

    expect(response.body).toMatchObject({
      replayed: false,
      suggestion: { id: suggestionId },
    });
    expect(suggest).toHaveBeenCalledWith({
      id: suggestionId,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });
    expect(approve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("assigns a ready category before a cover is published", async () => {
    createOrLoadPresentation.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { resourceId: RESOURCE_ID, categoryId: CATEGORY_ID, editionNumber: null },
    });

    const response = await request(app())
      .put(`/api/resources/${RESOURCE_ID}/presentation`)
      .send({ categoryId: CATEGORY_ID })
      .expect(201);

    expect(response.body.replayed).toBe(false);
    expect(createOrLoadPresentation).toHaveBeenCalledWith({
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
    });
  });

  it("requires the explicit move operation once a cover is published", async () => {
    findPresentation.mockResolvedValue({
      resourceId: RESOURCE_ID,
      categoryId: SECOND_CATEGORY_ID,
      editionNumber: 7,
    });
    repointPresentation.mockResolvedValue({
      ok: false,
      error: "cover_category_locked_by_publication",
    });

    await request(app())
      .put(`/api/resources/${RESOURCE_ID}/presentation`)
      .send({ categoryId: CATEGORY_ID })
      .expect(409, { error: "published_category_move_requires_explicit_operation" });

    expect(updatePresentation).not.toHaveBeenCalled();
  });

  it("moves an unpublished guide to another collection even once it has drafts", async () => {
    findPresentation
      .mockResolvedValueOnce({
        resourceId: RESOURCE_ID,
        categoryId: SECOND_CATEGORY_ID,
        editionNumber: null,
      })
      .mockResolvedValueOnce({
        resourceId: RESOURCE_ID,
        categoryId: CATEGORY_ID,
        editionNumber: null,
      });
    repointPresentation.mockResolvedValue({ ok: true, outcome: "moved" });

    const response = await request(app())
      .put(`/api/resources/${RESOURCE_ID}/presentation`)
      .send({ categoryId: CATEGORY_ID })
      .expect(200);

    expect(repointPresentation).toHaveBeenCalledWith({
      resourceId: RESOURCE_ID,
      toCategoryId: CATEGORY_ID,
    });
    expect(response.body.presentation.categoryId).toBe(CATEGORY_ID);
    expect(response.body.replayed).toBe(false);
  });

  it("moves a published guide only with the explicit expected category and cover revision", async () => {
    const response = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/presentation/move`)
      .send({
        expectedCategoryId: CATEGORY_ID,
        targetCategoryId: "10000000-0000-4000-8000-000000000002",
        expectedPublishedCoverId: COVER_ID,
        expectedPublishedCoverRevision: 2,
      })
      .expect(200);

    expect(move).toHaveBeenCalledWith({
      actorId: "creator@tinysoho.com",
      resourceId: RESOURCE_ID,
      expectedCategoryId: CATEGORY_ID,
      targetCategoryId: "10000000-0000-4000-8000-000000000002",
      expectedPublishedCoverId: COVER_ID,
      expectedPublishedCoverRevision: 2,
    });
    expect(response.body).toEqual({ ok: true, outcome: "moved", editionNumber: 4 });
  });

  it("rejects a collection move without its optimistic cover revision", async () => {
    await request(app())
      .post(`/api/resources/${RESOURCE_ID}/presentation/move`)
      .send({
        expectedCategoryId: CATEGORY_ID,
        targetCategoryId: "10000000-0000-4000-8000-000000000002",
        expectedPublishedCoverId: COVER_ID,
      })
      .expect(400);

    expect(move).not.toHaveBeenCalled();
  });

  it("creates a draft from server-owned visual keys and category labels", async () => {
    createOrLoadDraft.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { id: COVER_ID, revision: 1, status: "draft" },
    });

    const response = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions`)
      .set("idempotency-key", COVER_ID)
      .send({ id: COVER_ID, categoryId: CATEGORY_ID, copy })
      .expect(201);

    expect(response.body.cover).toMatchObject({ id: COVER_ID, revision: 1 });
    expect(createOrLoadDraft).toHaveBeenCalledWith({
      id: COVER_ID,
      resourceId: RESOURCE_ID,
      categoryId: CATEGORY_ID,
      suggestionId: null,
      templateKey: category.templateKey,
      paletteKey: category.paletteKey,
      illustrationKey: category.illustrationKey,
      copy: {
        ...copy,
        kicker: category.defaultKicker,
        collectionLabel: category.collectionLabel,
      },
    });
  });

  it("rejects a draft suggestion that belongs to another resource before mutating presentation state", async () => {
    createOrLoadDraft.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { id: COVER_ID, revision: 1, status: "draft" },
    });

    await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions`)
      .set("idempotency-key", COVER_ID)
      .send({
        id: COVER_ID,
        categoryId: CATEGORY_ID,
        suggestionId: SUGGESTION_ID,
        copy,
      })
      .expect(409, { error: "cover_suggestion_mismatch" });

    expect(findSuggestion).toHaveBeenCalledWith({
      where: {
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        suggestedCategoryId: CATEGORY_ID,
      },
      select: { id: true },
    });
    expect(createOrLoadPresentation).not.toHaveBeenCalled();
    expect(createOrLoadDraft).not.toHaveBeenCalled();
  });

  it("rejects a draft suggestion for a different category before mutating presentation state", async () => {
    findCategory.mockResolvedValue({ ...category, id: SECOND_CATEGORY_ID });
    createOrLoadDraft.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { id: COVER_ID, revision: 1, status: "draft" },
    });

    await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions`)
      .set("idempotency-key", COVER_ID)
      .send({
        id: COVER_ID,
        categoryId: SECOND_CATEGORY_ID,
        suggestionId: SUGGESTION_ID,
        copy,
      })
      .expect(409, { error: "cover_suggestion_mismatch" });

    expect(findSuggestion).toHaveBeenCalledWith({
      where: {
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        suggestedCategoryId: SECOND_CATEGORY_ID,
      },
      select: { id: true },
    });
    expect(createOrLoadPresentation).not.toHaveBeenCalled();
    expect(createOrLoadDraft).not.toHaveBeenCalled();
  });

  it("creates a draft when the suggestion provenance matches the requested resource and category", async () => {
    findSuggestion.mockResolvedValue({ id: SUGGESTION_ID });
    createOrLoadDraft.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { id: COVER_ID, revision: 1, status: "draft", suggestionId: SUGGESTION_ID },
    });

    const response = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions`)
      .set("idempotency-key", COVER_ID)
      .send({
        id: COVER_ID,
        categoryId: CATEGORY_ID,
        suggestionId: SUGGESTION_ID,
        copy,
      })
      .expect(201);

    expect(response.body.cover).toMatchObject({ id: COVER_ID, suggestionId: SUGGESTION_ID });
    expect(findSuggestion).toHaveBeenCalledWith({
      where: {
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        suggestedCategoryId: CATEGORY_ID,
      },
      select: { id: true },
    });
    expect(createOrLoadDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: RESOURCE_ID,
        categoryId: CATEGORY_ID,
        suggestionId: SUGGESTION_ID,
      }),
    );
  });

  it("maps a stale draft save to the stable revision-conflict response", async () => {
    saveDraft.mockResolvedValue({ ok: false, error: "cover_revision_conflict" });

    await request(app())
      .patch(`/api/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}`)
      .send({ expectedRevision: 3, copy })
      .expect(409, { error: "cover_revision_conflict" });
  });

  it("approves and publishes with the authenticated creator identity", async () => {
    approve.mockResolvedValue({ ok: true, outcome: "approved" });
    publish.mockResolvedValue({
      ok: true,
      outcome: "published",
      contentHash: "a".repeat(64),
      editionNumber: 1,
      path: "guide-covers/path/dm_cover.png",
    });

    const approved = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/approve`)
      .send({ expectedRevision: 1 })
      .expect(200);
    const published = await request(app())
      .post(`/api/resources/${RESOURCE_ID}/cover-versions/${COVER_ID}/publish`)
      .send({ expectedRevision: 1 })
      .expect(200);

    expect(approve).toHaveBeenCalledWith({
      actorId: "creator@tinysoho.com",
      coverVersionId: COVER_ID,
      expectedRevision: 1,
      resourceId: RESOURCE_ID,
    });
    expect(approved.body).toMatchObject({ outcome: "approved" });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ actorId: "creator@tinysoho.com" }));
    expect(published.body).toMatchObject({ outcome: "published", editionNumber: 1 });
  });
});
