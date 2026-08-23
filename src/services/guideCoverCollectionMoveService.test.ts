import { describe, expect, it, vi } from "vitest";

import { createGuideCoverCollectionMoveService } from "./guideCoverCollectionMoveService.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const OLD_CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_CATEGORY_ID = "10000000-0000-4000-8000-000000000002";
const COVER_ID = "30000000-0000-4000-8000-000000000001";

function fixture(overrides: Record<string, unknown> = {}) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ id: TARGET_CATEGORY_ID }])
    .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
    .mockResolvedValueOnce([{ id: COVER_ID }])
    .mockResolvedValueOnce([{ editionNumber: 4 }]);
  const target = {
    id: TARGET_CATEGORY_ID,
    designStatus: "ready",
    nextEditionNumber: 4,
  };
  const presentation = {
    resourceId: RESOURCE_ID,
    categoryId: OLD_CATEGORY_ID,
    editionNumber: 8,
  };
  const cover = {
    id: COVER_ID,
    resourceId: RESOURCE_ID,
    categoryId: OLD_CATEGORY_ID,
    editionNumber: 8,
    revision: 2,
    status: "published",
  };
  const tx = {
    $queryRaw: queryRaw,
    presentationCategory: { findUnique: vi.fn().mockResolvedValue(target) },
    resourcePresentation: {
      findUnique: vi.fn().mockResolvedValue(presentation),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    resourceCoverVersion: {
      findUnique: vi.fn().mockResolvedValue(cover),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
  };
  const database = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  };
  return { database, tx, target, presentation, cover };
}

const input = {
  actorId: "creator@tinysoho.com",
  resourceId: RESOURCE_ID,
  expectedCategoryId: OLD_CATEGORY_ID,
  targetCategoryId: TARGET_CATEGORY_ID,
  expectedPublishedCoverId: COVER_ID,
  expectedPublishedCoverRevision: 2,
};

describe("guide cover collection move", () => {
  it("locks in target-category, presentation, published-cover order and allocates once", async () => {
    const { database, tx } = fixture();
    const service = createGuideCoverCollectionMoveService({ database: database as never });

    await expect(service.move(input)).resolves.toEqual({
      ok: true,
      outcome: "moved",
      editionNumber: 4,
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.resourcePresentation.updateMany).toHaveBeenCalledWith({
      where: {
        resourceId: RESOURCE_ID,
        categoryId: OLD_CATEGORY_ID,
        editionNumber: 8,
      },
      data: { categoryId: TARGET_CATEGORY_ID, editionNumber: 4 },
    });
    expect(tx.resourceCoverVersion.updateMany).toHaveBeenCalledWith({
      where: {
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        categoryId: OLD_CATEGORY_ID,
        editionNumber: 8,
        revision: 2,
        status: "published",
      },
      data: { status: "retired" },
    });
  });

  it("returns an exact replay without allocating another edition", async () => {
    const { database, tx, presentation, cover } = fixture();
    Object.assign(presentation, { categoryId: TARGET_CATEGORY_ID, editionNumber: 4 });
    Object.assign(cover, { status: "retired" });
    tx.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: TARGET_CATEGORY_ID }])
      .mockResolvedValueOnce([{ resourceId: RESOURCE_ID }])
      .mockResolvedValueOnce([{ id: COVER_ID }]);
    const service = createGuideCoverCollectionMoveService({ database: database as never });

    await expect(service.move(input)).resolves.toEqual({
      ok: true,
      outcome: "replayed",
      editionNumber: 4,
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.resourcePresentation.updateMany).not.toHaveBeenCalled();
    expect(tx.resourceCoverVersion.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the expected cover revision is stale", async () => {
    const { database, cover, tx } = fixture();
    Object.assign(cover, { revision: 3 });
    const service = createGuideCoverCollectionMoveService({ database: database as never });

    await expect(service.move(input)).resolves.toEqual({
      ok: false,
      error: "cover_collection_move_conflict",
    });

    expect(tx.resourcePresentation.updateMany).not.toHaveBeenCalled();
  });

  it("requires different expected and target categories plus an actor", async () => {
    const { database } = fixture();
    const service = createGuideCoverCollectionMoveService({ database: database as never });

    await expect(
      service.move({ ...input, targetCategoryId: OLD_CATEGORY_ID }),
    ).resolves.toEqual({ ok: false, error: "cover_collection_move_invalid_input" });
    await expect(service.move({ ...input, actorId: "" })).resolves.toEqual({
      ok: false,
      error: "cover_collection_move_invalid_input",
    });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
