import { z } from "zod";
import type { Response } from "express";

import { GUIDE_COVER_CATEGORIES, getGuideCoverCategory } from "../../shared/guideCoverRegistry.js";
import { validateGuideCoverCategoryText } from "../../shared/guideCoverPolicy.js";
import { prisma } from "../lib/prisma.js";
import { flags } from "../services/flagService.js";
import { createPresentationCategoryRepository } from "../services/presentationCategoryRepository.js";
import { asyncRouter } from "./asyncRouter.js";
import { idempotencyKeyMismatch } from "./createReplay.js";

export const presentationCategoriesRouter = asyncRouter();
const categories = createPresentationCategoryRepository();

const idSchema = z.string().uuid();
const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const createSchema = z.object({
  id: z.string().uuid(),
  slug: slugSchema,
  name: z.string().trim().min(1).max(80),
  collectionLabel: z.string(),
  defaultKicker: z.string(),
  basedOnCategorySlug: z.enum(
    Object.keys(GUIDE_COVER_CATEGORIES) as [
      keyof typeof GUIDE_COVER_CATEGORIES,
      ...(keyof typeof GUIDE_COVER_CATEGORIES)[],
    ],
  ),
  sortOrder: z.number().int().min(0).max(10_000).nullish(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    collectionLabel: z.string().optional(),
    defaultKicker: z.string().optional(),
    sortOrder: z.number().int().min(0).max(10_000).nullable().optional(),
    designStatus: z.enum(["needs_review", "inactive"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty_update" });

function authoringEnabled(res: Response): boolean {
  if (flags.bool("GUIDE_COVER_AUTHORING_ENABLED")) return true;
  res.status(403).json({ error: "guide_cover_authoring_disabled" });
  return false;
}

presentationCategoriesRouter.get("/", async (_req, res) => {
  if (!authoringEnabled(res)) return;
  res.json({ categories: await categories.list(false) });
});

presentationCategoriesRouter.post("/", async (req, res) => {
  if (!authoringEnabled(res)) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.adminEmail) return res.status(403).json({ error: "creator_identity_missing" });
  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }
  if (getGuideCoverCategory(parsed.data.slug)) {
    return res.status(409).json({ error: "presentation_category_reserved" });
  }

  const text = validateGuideCoverCategoryText({
    kicker: parsed.data.defaultKicker,
    collectionLabel: parsed.data.collectionLabel,
  });
  if (!text.ok) return res.status(422).json({ error: text.error.code, field: text.error.field });
  const base = getGuideCoverCategory(parsed.data.basedOnCategorySlug);
  if (!base) return res.status(400).json({ error: "cover_invalid_visual_key" });

  const result = await categories.createOrLoad({
    id: parsed.data.id,
    slug: parsed.data.slug,
    name: parsed.data.name,
    collectionLabel: text.value.collectionLabel,
    defaultKicker: text.value.kicker,
    templateKey: base.templateKey,
    paletteKey: base.paletteKey,
    illustrationKey: base.illustrationKey,
    designStatus: "needs_review",
    sortOrder: parsed.data.sortOrder ?? null,
    createdBy: req.adminEmail,
    updatedBy: req.adminEmail,
  });
  if (!result.ok) {
    const status = result.error === "presentation_category_duplicate" ? 409 : 503;
    return res.status(status).json({ error: result.error });
  }
  res.status(result.replayed ? 200 : 201).json({
    category: result.value,
    replayed: result.replayed,
  });
});

presentationCategoriesRouter.patch("/:id", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: "invalid_category_id" });
  }
  if (req.body?.designStatus === "ready") {
    return res.status(400).json({ error: "category_ready_requires_code_review" });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.adminEmail) return res.status(403).json({ error: "creator_identity_missing" });

  const existing = await prisma.presentationCategory.findUnique({
    where: { id: req.params.id },
  });
  if (!existing) return res.status(404).json({ error: "not_found" });
  if (existing.designStatus === "ready") {
    return res.status(409).json({ error: "ready_category_is_code_owned" });
  }

  let normalizedText: { kicker?: string; collectionLabel?: string } = {};
  if (parsed.data.defaultKicker !== undefined || parsed.data.collectionLabel !== undefined) {
    const text = validateGuideCoverCategoryText({
      kicker: parsed.data.defaultKicker ?? existing.defaultKicker,
      collectionLabel: parsed.data.collectionLabel ?? existing.collectionLabel,
    });
    if (!text.ok) return res.status(422).json({ error: text.error.code, field: text.error.field });
    normalizedText = {
      kicker: text.value.kicker,
      collectionLabel: text.value.collectionLabel,
    };
  }

  const category = await prisma.presentationCategory.update({
    where: { id: req.params.id },
    data: {
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.sortOrder === undefined ? {} : { sortOrder: parsed.data.sortOrder }),
      ...(parsed.data.designStatus === undefined
        ? {}
        : { designStatus: parsed.data.designStatus }),
      ...normalizedText,
      updatedBy: req.adminEmail,
    },
  });
  res.json({ category });
});
