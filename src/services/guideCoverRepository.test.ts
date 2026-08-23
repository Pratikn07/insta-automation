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
  return {
    resourcePresentation: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    resourceCoverVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  };
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

  it("increments the draft revision behind an optimistic fence", async () => {
    const db = database();
    db.resourceCoverVersion.updateMany.mockResolvedValue({ count: 1 });
    db.resourceCoverVersion.findUnique.mockResolvedValue({ ...draft, revision: 2 });
    const repository = createGuideCoverRepository({ database: db });

    await expect(
      repository.saveDraft({
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 1,
        copy: { ...copy, headline: "A gentler bedtime" },
      }),
    ).resolves.toMatchObject({ ok: true, value: { revision: 2 } });
    expect(db.resourceCoverVersion.updateMany).toHaveBeenCalledWith({
      where: {
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        revision: 1,
        status: "draft",
      },
      data: expect.objectContaining({ revision: 2, headline: "A gentler bedtime" }),
    });
  });

  it("returns a stable conflict when the draft fence loses", async () => {
    const db = database();
    db.resourceCoverVersion.updateMany.mockResolvedValue({ count: 0 });
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
