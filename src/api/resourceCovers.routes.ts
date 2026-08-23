import { z } from "zod";
import type { Response } from "express";

import type { GuideCoverDraft } from "../../shared/guideCoverPolicy.js";
import { prisma } from "../lib/prisma.js";
import { publicMediaUrl } from "../lib/supabase.js";
import { flags } from "../services/flagService.js";
import { createGuideCoverCollectionMoveService } from "../services/guideCoverCollectionMoveService.js";
import { createGuideCoverPublishService } from "../services/guideCoverPublishService.js";
import { createGuideCoverRepository } from "../services/guideCoverRepository.js";
import { createGuideCoverSuggestionService } from "../services/guideCoverSuggestionService.js";
import { asyncRouter } from "./asyncRouter.js";
import { idempotencyKeyMismatch } from "./createReplay.js";

export const resourceCoversRouter = asyncRouter();
const covers = createGuideCoverRepository();
const publishing = createGuideCoverPublishService();
const collectionMoves = createGuideCoverCollectionMoveService();
const suggestions = createGuideCoverSuggestionService();

const uuid = z.string().uuid();
const copySchema = z.object({
  headline: z.string(),
  supportingLine: z.string(),
  closingLine: z.string(),
  alternativeDescription: z.string(),
});
const presentationSchema = z.object({ categoryId: z.string().uuid() });
const createDraftSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  suggestionId: z.string().uuid().nullable().optional(),
  copy: copySchema,
});
const createSuggestionSchema = z.object({
  id: z.string().uuid(),
  selectedCategoryId: z.string().uuid().nullable().optional(),
});
const saveDraftSchema = z.object({
  expectedRevision: z.number().int().min(1),
  copy: copySchema,
});
const lifecycleSchema = z.object({ expectedRevision: z.number().int().min(1) });
const collectionMoveSchema = z.object({
  expectedCategoryId: z.string().uuid(),
  targetCategoryId: z.string().uuid(),
  expectedPublishedCoverId: z.string().uuid(),
  expectedPublishedCoverRevision: z.number().int().min(1),
});

function validResourceAndCoverIds(resourceId: string, coverVersionId?: string): boolean {
  return (
    uuid.safeParse(resourceId).success &&
    (coverVersionId === undefined || uuid.safeParse(coverVersionId).success)
  );
}

function authoringEnabled(res: Response): boolean {
  if (flags.bool("GUIDE_COVER_AUTHORING_ENABLED")) return true;
  res.status(403).json({ error: "guide_cover_authoring_disabled" });
  return false;
}

function creatorId(req: { adminEmail?: string }, res: Response): string | null {
  if (req.adminEmail) return req.adminEmail;
  res.status(403).json({ error: "creator_identity_missing" });
  return null;
}

function repositoryFailure(res: Response, error: string) {
  const status =
    error === "cover_revision_conflict" || error === "cover_create_conflict"
      ? 409
      : error === "cover_invalid_input"
        ? 422
        : 503;
  return res.status(status).json({ error });
}

function lifecycleFailure(res: Response, error: string) {
  const status =
    error === "cover_publish_conflict" || error === "cover_not_approved"
      ? 409
      : error === "cover_invalid_input" ||
          error === "cover_invalid_visual_key" ||
          error === "cover_text_overflow"
        ? 422
        : error === "presentation_category_not_ready"
          ? 409
          : 503;
  return res.status(status).json({ error });
}

resourceCoversRouter.get("/:resourceId/published-cover", async (req, res) => {
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const cover = await covers.findPublished(req.params.resourceId);
  if (!cover) return res.status(404).json({ error: "not_found" });
  res.json({
    cover: {
      id: cover.id,
      resourceId: cover.resourceId,
      revision: cover.revision,
      status: cover.status,
      categoryId: cover.categoryId,
      editionNumber: cover.editionNumber,
      contentHash: cover.contentHash,
      dmStoragePath: cover.dmStoragePath,
      publicUrl: publicMediaUrl(cover.dmStoragePath!),
      publishedAt: cover.publishedAt,
    },
  });
});

resourceCoversRouter.get("/:resourceId/presentation", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const [presentation, versions] = await Promise.all([
    prisma.resourcePresentation.findUnique({
      where: { resourceId: req.params.resourceId },
      include: { category: true },
    }),
    prisma.resourceCoverVersion.findMany({
      where: { resourceId: req.params.resourceId },
      orderBy: { revision: "desc" },
    }),
  ]);
  res.json({ presentation, coverVersions: versions });
});

resourceCoversRouter.put("/:resourceId/presentation", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const parsed = presentationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const category = await prisma.presentationCategory.findFirst({
    where: { id: parsed.data.categoryId, designStatus: "ready" },
  });
  if (!category) return res.status(409).json({ error: "presentation_category_not_ready" });

  const existing = await prisma.resourcePresentation.findUnique({
    where: { resourceId: req.params.resourceId },
  });
  if (!existing) {
    const result = await covers.createOrLoadPresentation({
      resourceId: req.params.resourceId,
      categoryId: parsed.data.categoryId,
    });
    if (!result.ok) return repositoryFailure(res, result.error);
    return res.status(result.replayed ? 200 : 201).json({
      presentation: result.value,
      replayed: result.replayed,
    });
  }
  if (existing.categoryId === parsed.data.categoryId) {
    return res.json({ presentation: existing, replayed: true });
  }

  const publishedCount = await prisma.resourceCoverVersion.count({
    where: { resourceId: req.params.resourceId, status: "published" },
  });
  if (publishedCount > 0 || existing.editionNumber !== null) {
    return res.status(409).json({
      error: "published_category_move_requires_explicit_operation",
    });
  }
  const anyCoverCount = await prisma.resourceCoverVersion.count({
    where: { resourceId: req.params.resourceId },
  });
  if (anyCoverCount > 0) {
    return res.status(409).json({ error: "presentation_has_cover_versions" });
  }
  const updated = await prisma.resourcePresentation.updateMany({
    where: {
      resourceId: req.params.resourceId,
      categoryId: existing.categoryId,
      editionNumber: null,
    },
    data: { categoryId: parsed.data.categoryId },
  });
  if (updated.count !== 1) {
    return res.status(409).json({ error: "cover_revision_conflict" });
  }
  const presentation = await prisma.resourcePresentation.findUnique({
    where: { resourceId: req.params.resourceId },
  });
  res.json({ presentation, replayed: false });
});

resourceCoversRouter.post("/:resourceId/presentation/move", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const parsed = collectionMoveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const actorId = creatorId(req, res);
  if (!actorId) return;
  const result = await collectionMoves.move({
    actorId,
    resourceId: req.params.resourceId,
    ...parsed.data,
  });
  if (!result.ok) {
    const status =
      result.error === "cover_collection_move_invalid_input"
        ? 422
        : result.error === "presentation_category_not_ready"
          ? 409
          : 409;
    return res.status(status).json({ error: result.error });
  }
  res.json(result);
});

resourceCoversRouter.post("/:resourceId/cover-suggestions", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const parsed = createSuggestionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }
  const result = await suggestions.suggest({
    id: parsed.data.id,
    resourceId: req.params.resourceId,
    selectedCategoryId: parsed.data.selectedCategoryId ?? null,
  });
  if (!result.ok) {
    const status =
      result.error === "resource_not_found"
        ? 404
        : result.error === "presentation_category_not_ready" ||
            result.error === "cover_suggestion_conflict"
          ? 409
          : result.error === "cover_suggestion_invalid_input"
            ? 422
            : 503;
    return res.status(status).json({ error: result.error });
  }
  res.status(result.replayed ? 200 : 201).json(result);
});

resourceCoversRouter.post("/:resourceId/cover-versions", async (req, res) => {
  if (!authoringEnabled(res)) return;
  if (!validResourceAndCoverIds(req.params.resourceId)) {
    return res.status(400).json({ error: "invalid_resource_id" });
  }
  const parsed = createDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }
  const category = await prisma.presentationCategory.findFirst({
    where: { id: parsed.data.categoryId, designStatus: "ready" },
  });
  if (!category) return res.status(409).json({ error: "presentation_category_not_ready" });
  const suggestionId = parsed.data.suggestionId ?? null;
  if (suggestionId !== null) {
    const suggestion = await prisma.resourceCoverSuggestion.findFirst({
      where: {
        id: suggestionId,
        resourceId: req.params.resourceId,
        suggestedCategoryId: parsed.data.categoryId,
      },
      select: { id: true },
    });
    if (!suggestion) return res.status(409).json({ error: "cover_suggestion_mismatch" });
  }

  const presentation = await covers.createOrLoadPresentation({
    resourceId: req.params.resourceId,
    categoryId: parsed.data.categoryId,
  });
  if (!presentation.ok) return repositoryFailure(res, presentation.error);
  const result = await covers.createOrLoadDraft({
    id: parsed.data.id,
    resourceId: req.params.resourceId,
    categoryId: parsed.data.categoryId,
    templateKey: category.templateKey,
    paletteKey: category.paletteKey,
    illustrationKey: category.illustrationKey,
    suggestionId,
    copy: {
      ...(parsed.data.copy as GuideCoverDraft),
      kicker: category.defaultKicker,
      collectionLabel: category.collectionLabel,
    },
  });
  if (!result.ok) return repositoryFailure(res, result.error);
  res.status(result.replayed ? 200 : 201).json({
    cover: result.value,
    replayed: result.replayed,
  });
});

resourceCoversRouter.patch(
  "/:resourceId/cover-versions/:coverVersionId",
  async (req, res) => {
    if (!authoringEnabled(res)) return;
    if (!validResourceAndCoverIds(req.params.resourceId, req.params.coverVersionId)) {
      return res.status(400).json({ error: "invalid_cover_identity" });
    }
    const parsed = saveDraftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const cover = await prisma.resourceCoverVersion.findUnique({
      where: { id: req.params.coverVersionId },
    });
    if (!cover || cover.resourceId !== req.params.resourceId) {
      return res.status(404).json({ error: "not_found" });
    }
    const category = await prisma.presentationCategory.findFirst({
      where: { id: cover.categoryId, designStatus: "ready" },
    });
    if (!category) return res.status(409).json({ error: "presentation_category_not_ready" });
    const result = await covers.saveDraft({
      id: req.params.coverVersionId,
      resourceId: req.params.resourceId,
      expectedRevision: parsed.data.expectedRevision,
      copy: {
        ...(parsed.data.copy as GuideCoverDraft),
        kicker: category.defaultKicker,
        collectionLabel: category.collectionLabel,
      },
    });
    if (!result.ok) return repositoryFailure(res, result.error);
    res.json({ cover: result.value });
  },
);

for (const action of ["approve", "publish"] as const) {
  resourceCoversRouter.post(
    `/:resourceId/cover-versions/:coverVersionId/${action}`,
    async (req, res) => {
      if (!authoringEnabled(res)) return;
      if (!validResourceAndCoverIds(req.params.resourceId, req.params.coverVersionId)) {
        return res.status(400).json({ error: "invalid_cover_identity" });
      }
      const parsed = lifecycleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const actorId = creatorId(req, res);
      if (!actorId) return;
      const result = await publishing[action]({
        actorId,
        coverVersionId: req.params.coverVersionId,
        expectedRevision: parsed.data.expectedRevision,
        resourceId: req.params.resourceId,
      });
      if (!result.ok) return lifecycleFailure(res, result.error);
      res.json(result);
    },
  );
}
