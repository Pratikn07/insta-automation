import { describe, expect, it, vi } from "vitest";

import { createGuideCoverPublishService } from "./guideCoverPublishService.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T12:00:00.000Z");
const contentHash = "a".repeat(64);
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
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
  nextEditionNumber: 1,
  sortOrder: 10,
  createdBy: "owner",
  updatedBy: "owner",
  createdAt: NOW,
  updatedAt: NOW,
};
const presentation = {
  resourceId: RESOURCE_ID,
  categoryId: CATEGORY_ID,
  editionNumber: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const cover = {
  id: COVER_ID,
  resourceId: RESOURCE_ID,
  revision: 2,
  status: "approved",
  renderStatus: "not_rendered",
  categoryId: CATEGORY_ID,
  editionNumber: null,
  templateKey: category.templateKey,
  paletteKey: category.paletteKey,
  illustrationKey: category.illustrationKey,
  kicker: category.defaultKicker,
  collectionLabel: category.collectionLabel,
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A TinySoho bedtime guide cover.",
  suggestionId: null,
  contentHash: null,
  dmStoragePath: null,
  genericStoragePath: null,
  renderErrorCode: null,
  approvedBy: "owner",
  approvedAt: NOW,
  publishedBy: null,
  publishedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function setup(overrides: {
  cover?: typeof cover | null;
  presentation?: typeof presentation | null;
  category?: typeof category | null;
} = {}) {
  const order: string[] = [];
  let inTransaction = false;
  let queryCount = 0;
  const currentCover = overrides.cover === undefined ? cover : overrides.cover;
  const currentPresentation =
    overrides.presentation === undefined ? presentation : overrides.presentation;
  const currentCategory =
    overrides.category === undefined ? category : overrides.category;
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => {
      queryCount += 1;
      if (queryCount === 4) {
        return [{ editionNumber: 1 }];
      }
      return [{ id: COVER_ID }];
    }),
    resourcePresentation: {
      findUnique: vi.fn(async () => currentPresentation),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    resourceCoverVersion: {
      findUnique: vi.fn(async () => currentCover),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const database = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      order.push("transaction");
      inTransaction = true;
      try {
        return await operation(tx);
      } finally {
        inTransaction = false;
      }
    }),
    guideCoverOrphan: { create: vi.fn(), findUnique: vi.fn() },
    presentationCategory: {
      findUnique: vi.fn(async () => currentCategory),
    },
    resourcePresentation: {
      findUnique: vi.fn(async () => currentPresentation),
    },
    resourceCoverVersion: {
      findUnique: vi.fn(async () => currentCover),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const renderer = vi.fn(async () => {
    order.push("render");
    expect(inTransaction).toBe(false);
    return {
      ok: true as const,
      value: {
        contentHash,
        filename: "dm.png" as const,
        height: 916,
        png,
        pngHash: "b".repeat(64),
        rendition: "dm_cover" as const,
        rendererVersion: "tinysoho-guide-cover-v1" as const,
        svg: "<svg/>",
        width: 1200,
      },
    };
  });
  const storage = {
    upload: vi.fn(async () => {
      order.push("upload");
      expect(inTransaction).toBe(false);
      return {
        ok: true as const,
        value: {
          outcome: "uploaded" as const,
          path: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${contentHash}/dm.png`,
          publicUrl: "https://cdn.example/dm.png",
        },
      };
    }),
  };
  const service = createGuideCoverPublishService({
    database,
    renderer,
    storage,
    now: () => NOW,
  });
  return { database, order, renderer, service, storage, tx };
}

describe("guide cover publish service", () => {
  it("approves after deterministic validation without uploading", async () => {
    const { database, renderer, service, storage } = setup({
      cover: { ...cover, status: "draft", approvedBy: null, approvedAt: null },
    });

    await expect(
      service.approve({
        coverVersionId: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 2,
        actorId: "owner",
      }),
    ).resolves.toEqual({ ok: true, outcome: "approved" });
    expect(renderer).toHaveBeenCalledOnce();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(database.resourceCoverVersion.updateMany).toHaveBeenCalledWith({
      where: {
        id: COVER_ID,
        resourceId: RESOURCE_ID,
        revision: 2,
        status: "draft",
      },
      data: { status: "approved", approvedBy: "owner", approvedAt: NOW },
    });
  });

  it("renders and uploads before entering the publication transaction", async () => {
    const { order, service, storage, tx } = setup();

    const result = await service.publish({
      coverVersionId: COVER_ID,
      resourceId: RESOURCE_ID,
      expectedRevision: 2,
      actorId: "owner",
    });
    expect(result).toEqual({
      ok: true,
      outcome: "published",
      contentHash,
      editionNumber: 1,
      path: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${contentHash}/dm.png`,
      publicUrl: "https://cdn.example/dm.png",
    });
    expect(order).toEqual(["render", "upload", "transaction"]);
    expect(storage.upload).toHaveBeenCalledWith({
      resourceId: RESOURCE_ID,
      coverVersionId: COVER_ID,
      contentHash,
      rendition: "dm_cover",
      png,
    });
    expect(tx.resourceCoverVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "approved", revision: 2 }),
        data: expect.objectContaining({
          status: "published",
          renderStatus: "ready",
          editionNumber: 1,
          contentHash,
        }),
      }),
    );
  });

  it("returns an exact published replay without rendering or uploading", async () => {
    const published = {
      ...cover,
      status: "published",
      renderStatus: "ready",
      editionNumber: 1,
      contentHash,
      dmStoragePath: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${contentHash}/dm.png`,
      publishedBy: "owner",
      publishedAt: NOW,
    };
    const { database, renderer, service, storage } = setup({ cover: published });

    await expect(
      service.publish({
        coverVersionId: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 2,
        actorId: "owner",
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "replayed", editionNumber: 1 });
    expect(renderer).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("preserves the database when upload fails", async () => {
    const { database, service, storage } = setup();
    storage.upload.mockResolvedValue({ ok: false, error: "cover_storage_failed" });

    await expect(
      service.publish({
        coverVersionId: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 2,
        actorId: "owner",
      }),
    ).resolves.toEqual({ ok: false, error: "cover_storage_failed" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("records the exact uploaded object when the database publish fails", async () => {
    const { database, service } = setup();
    database.$transaction.mockRejectedValue(new Error("private database body"));

    await expect(
      service.publish({
        coverVersionId: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 2,
        actorId: "owner",
      }),
    ).resolves.toEqual({ ok: false, error: "cover_publish_conflict" });
    expect(database.guideCoverOrphan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash,
        rendition: "dm_cover",
        storagePath: `guide-cover/${RESOURCE_ID}/${COVER_ID}/${contentHash}/dm.png`,
      }),
    });
  });

  it("fails closed when the cover is not approved", async () => {
    const { renderer, service, storage } = setup({
      cover: { ...cover, status: "draft", approvedBy: null, approvedAt: null },
    });

    await expect(
      service.publish({
        coverVersionId: COVER_ID,
        resourceId: RESOURCE_ID,
        expectedRevision: 2,
        actorId: "owner",
      }),
    ).resolves.toEqual({ ok: false, error: "cover_not_approved" });
    expect(renderer).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
