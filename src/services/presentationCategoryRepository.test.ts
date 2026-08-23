import { describe, expect, it, vi } from "vitest";

import { createPresentationCategoryRepository } from "./presentationCategoryRepository.js";

const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T12:00:00.000Z");
const category = {
  id: CATEGORY_ID,
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready" as const,
  nextEditionNumber: 1,
  sortOrder: 10,
  createdBy: "owner",
  updatedBy: "owner",
  createdAt: NOW,
  updatedAt: NOW,
};

function database() {
  return {
    presentationCategory: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };
}

describe("presentation category repository", () => {
  it("creates an owner-supplied UUID category", async () => {
    const db = database();
    db.presentationCategory.create.mockResolvedValue(category);
    const repository = createPresentationCategoryRepository({ database: db });

    await expect(repository.createOrLoad(category)).resolves.toEqual({
      ok: true,
      value: category,
      replayed: false,
    });
    expect(db.presentationCategory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: CATEGORY_ID, slug: "bedtime" }),
    });
  });

  it("returns an exact UUID replay without changing the stored category", async () => {
    const db = database();
    db.presentationCategory.create.mockRejectedValue({ code: "P2002" });
    db.presentationCategory.findUnique.mockResolvedValue(category);
    const repository = createPresentationCategoryRepository({ database: db });

    await expect(repository.createOrLoad(category)).resolves.toEqual({
      ok: true,
      value: category,
      replayed: true,
    });
  });

  it("fails closed when a duplicate is not an exact replay", async () => {
    const db = database();
    db.presentationCategory.create.mockRejectedValue({ code: "P2002" });
    db.presentationCategory.findUnique.mockResolvedValue({
      ...category,
      paletteKey: "different_palette",
    });
    const repository = createPresentationCategoryRepository({ database: db });

    await expect(repository.createOrLoad(category)).resolves.toEqual({
      ok: false,
      error: "presentation_category_duplicate",
    });
  });

  it("returns only a ready category from the publication lookup", async () => {
    const db = database();
    db.presentationCategory.findFirst.mockResolvedValue(category);
    const repository = createPresentationCategoryRepository({ database: db });

    await expect(repository.findReadyById(CATEGORY_ID)).resolves.toBe(category);
    expect(db.presentationCategory.findFirst).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID, designStatus: "ready" },
    });
  });
});
