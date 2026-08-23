import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bool = vi.fn();
const createOrLoadPresentation = vi.fn();
const createOrLoadDraft = vi.fn();
const saveDraft = vi.fn();
const findPublished = vi.fn();
const approve = vi.fn();
const publish = vi.fn();
const move = vi.fn();
const findCategory = vi.fn();
const findPresentation = vi.fn();
const findCovers = vi.fn();
const findCover = vi.fn();
const updatePresentation = vi.fn();
const countPublished = vi.fn();

vi.mock("../services/flagService.js", () => ({ flags: { bool } }));
vi.mock("../services/guideCoverRepository.js", () => ({
  createGuideCoverRepository: () => ({
    createOrLoadPresentation,
    createOrLoadDraft,
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
  },
}));

const { resourceCoversRouter } = await import("./resourceCovers.routes.js");

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";

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
  updatePresentation.mockResolvedValue({ count: 1 });
  findPublished.mockResolvedValue(null);
  move.mockResolvedValue({ ok: true, outcome: "moved", editionNumber: 4 });
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
        `guide-covers/${RESOURCE_ID}/${COVER_ID}/${"a".repeat(64)}/dm_cover.png`,
      contentHash: "a".repeat(64),
    });

    const response = await request(app())
      .get(`/api/resources/${RESOURCE_ID}/published-cover`)
      .expect(200);

    expect(response.body.cover).toMatchObject({ id: COVER_ID, status: "published" });
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
      categoryId: "10000000-0000-4000-8000-000000000002",
      editionNumber: 7,
    });
    countPublished.mockResolvedValue(1);

    await request(app())
      .put(`/api/resources/${RESOURCE_ID}/presentation`)
      .send({ categoryId: CATEGORY_ID })
      .expect(409, { error: "published_category_move_requires_explicit_operation" });

    expect(updatePresentation).not.toHaveBeenCalled();
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
