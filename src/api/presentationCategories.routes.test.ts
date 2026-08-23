import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bool = vi.fn();
const list = vi.fn();
const createOrLoad = vi.fn();
const update = vi.fn();
const findUnique = vi.fn();

vi.mock("../services/flagService.js", () => ({ flags: { bool } }));
vi.mock("../services/presentationCategoryRepository.js", () => ({
  createPresentationCategoryRepository: () => ({ list, createOrLoad }),
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: { presentationCategory: { findUnique, update } },
}));

const { presentationCategoriesRouter } = await import(
  "./presentationCategories.routes.js"
);

const CATEGORY_ID = "10000000-0000-4000-8000-000000000099";

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    req.adminEmail = "creator@tinysoho.com";
    next();
  });
  value.use("/api/presentation-categories", presentationCategoriesRouter);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  bool.mockReturnValue(true);
  list.mockResolvedValue([]);
  findUnique.mockResolvedValue(null);
  update.mockResolvedValue({ id: CATEGORY_ID, designStatus: "needs_review" });
});

describe("presentation category API", () => {
  it("fails closed while cover authoring is disabled", async () => {
    bool.mockReturnValue(false);

    await request(app()).get("/api/presentation-categories").expect(403, {
      error: "guide_cover_authoring_disabled",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("lists categories in repository order", async () => {
    list.mockResolvedValue([{ id: CATEGORY_ID, slug: "new-theme" }]);

    const response = await request(app())
      .get("/api/presentation-categories")
      .expect(200);

    expect(response.body.categories).toEqual([
      { id: CATEGORY_ID, slug: "new-theme" },
    ]);
    expect(list).toHaveBeenCalledWith(false);
  });

  it("derives a stable slug for a reusable category from its name", async () => {
    createOrLoad.mockResolvedValue({
      ok: true,
      replayed: false,
      value: { id: CATEGORY_ID, slug: "feeding-tips" },
    });

    const response = await request(app())
      .post("/api/presentation-categories")
      .set("idempotency-key", CATEGORY_ID)
      .send({
        id: CATEGORY_ID,
        name: "Feeding Tips",
        collectionLabel: "FEEDING",
        defaultKicker: "A LITTLE WIN AT THE TABLE",
        basedOnCategorySlug: "recipes",
        sortOrder: 50,
      })
      .expect(201);

    expect(response.body.replayed).toBe(false);
    expect(createOrLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CATEGORY_ID,
        slug: "feeding-tips",
        designStatus: "needs_review",
        templateKey: "warm_editorial_corner_v1",
        paletteKey: "recipes_corner_table_v1",
        illustrationKey: "recipes_corner_bowl_v1",
        createdBy: "creator@tinysoho.com",
      }),
    );
  });

  it("rejects an idempotency header that disagrees with the category id", async () => {
    await request(app())
      .post("/api/presentation-categories")
      .set("idempotency-key", "20000000-0000-4000-8000-000000000099")
      .send({
        id: CATEGORY_ID,
        slug: "travel",
        name: "Travel",
        collectionLabel: "OUTINGS",
        defaultKicker: "A LITTLE WIN OUT AND ABOUT",
        basedOnCategorySlug: "bedtime",
      })
      .expect(400, { error: "idempotency_key_mismatch" });

    expect(createOrLoad).not.toHaveBeenCalled();
  });

  it("lets a creator rename or deactivate a needs-review category but never mark it ready", async () => {
    findUnique.mockResolvedValue({ id: CATEGORY_ID, designStatus: "needs_review" });

    await request(app())
      .patch(`/api/presentation-categories/${CATEGORY_ID}`)
      .send({ name: "Family Travel", designStatus: "inactive" })
      .expect(200);

    expect(update).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
      data: expect.objectContaining({
        name: "Family Travel",
        designStatus: "inactive",
        updatedBy: "creator@tinysoho.com",
      }),
    });

    await request(app())
      .patch(`/api/presentation-categories/${CATEGORY_ID}`)
      .send({ designStatus: "ready" })
      .expect(400, { error: "category_ready_requires_code_review" });
  });

  it("persists normalized collection label and kicker fields for a needs-review category", async () => {
    findUnique.mockResolvedValue({
      id: CATEGORY_ID,
      collectionLabel: "OLD",
      defaultKicker: "OLD KICKER",
      designStatus: "needs_review",
    });
    update.mockResolvedValue({
      id: CATEGORY_ID,
      collectionLabel: "TRAVEL",
      defaultKicker: "A LITTLE WIN OUTSIDE",
      designStatus: "needs_review",
    });

    const response = await request(app())
      .patch(`/api/presentation-categories/${CATEGORY_ID}`)
      .send({
        collectionLabel: " travel ",
        defaultKicker: " a little win outside ",
      })
      .expect(200);

    expect(response.body.category).toEqual({
      id: CATEGORY_ID,
      collectionLabel: "TRAVEL",
      defaultKicker: "A LITTLE WIN OUTSIDE",
      designStatus: "needs_review",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
      data: expect.objectContaining({
        collectionLabel: "TRAVEL",
        defaultKicker: "A LITTLE WIN OUTSIDE",
        updatedBy: "creator@tinysoho.com",
      }),
    });
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("kicker");
  });
});
