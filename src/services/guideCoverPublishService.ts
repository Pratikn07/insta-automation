import { randomUUID } from "node:crypto";

import type {
  PresentationCategory,
  PrismaClient,
  ResourceCoverVersion,
  ResourcePresentation,
} from "@prisma/client";

import type { GuideCoverRenderInput } from "../../shared/guideCoverPolicy.js";
import { prisma } from "../lib/prisma.js";
import {
  renderGuideCoverPng,
  type RenderGuideCoverPngResult,
} from "./guideCoverPngRenderer.js";
import {
  createGuideCoverStorage,
  type GuideCoverStorage,
} from "./guideCoverStorage.js";

export type GuideCoverPublishDatabase = Pick<
  PrismaClient,
  | "$transaction"
  | "guideCoverOrphan"
  | "presentationCategory"
  | "resourceCoverVersion"
  | "resourcePresentation"
>;

export interface GuideCoverPublishInput {
  actorId: string;
  coverVersionId: string;
  expectedRevision: number;
  resourceId: string;
}

type GuideCoverPublishError =
  | "cover_invalid_input"
  | "cover_not_approved"
  | "cover_publish_conflict"
  | "cover_render_failed"
  | "cover_storage_conflict"
  | "cover_storage_failed"
  | "cover_storage_invalid_identity"
  | "cover_storage_invalid_png"
  | "cover_storage_outcome_unknown"
  | "cover_text_overflow"
  | "cover_invalid_visual_key"
  | "presentation_category_not_ready";

export type ApproveGuideCoverResult =
  | { ok: true; outcome: "approved" | "replayed" }
  | { ok: false; error: GuideCoverPublishError };

export type PublishGuideCoverResult =
  | {
      ok: true;
      outcome: "published" | "replayed";
      contentHash: string;
      editionNumber: number;
      path: string;
      publicUrl?: string;
    }
  | { ok: false; error: GuideCoverPublishError };

type Renderer = (
  input: GuideCoverRenderInput,
  rendition: "dm_cover",
) => Promise<RenderGuideCoverPngResult>;

class PublicationConflict extends Error {
  constructor() {
    super("cover_publish_conflict");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002",
  );
}

function validMutationInput(input: GuideCoverPublishInput): boolean {
  return (
    input.actorId.trim().length > 0 &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 1
  );
}

function renderInput(
  cover: ResourceCoverVersion,
  category: PresentationCategory,
  editionNumber: number,
): GuideCoverRenderInput {
  return {
    categorySlug: category.slug,
    editionNumber,
    kicker: cover.kicker,
    collectionLabel: cover.collectionLabel,
    templateKey: cover.templateKey,
    paletteKey: cover.paletteKey,
    illustrationKey: cover.illustrationKey,
    headline: cover.headline,
    supportingLine: cover.supportingLine,
    closingLine: cover.closingLine,
    alternativeDescription: cover.alternativeDescription,
  };
}

function renderFailure(result: Exclude<RenderGuideCoverPngResult, { ok: true }>): {
  ok: false;
  error: GuideCoverPublishError;
} {
  if (
    result.error.code === "cover_text_overflow" ||
    result.error.code === "cover_invalid_visual_key" ||
    result.error.code === "cover_invalid_input"
  ) {
    return { ok: false, error: result.error.code };
  }
  return { ok: false, error: "cover_render_failed" };
}

function exactPublishedReplay(
  cover: ResourceCoverVersion,
  input: GuideCoverPublishInput,
): PublishGuideCoverResult | null {
  if (
    cover.resourceId !== input.resourceId ||
    cover.revision !== input.expectedRevision ||
    cover.status !== "published" ||
    cover.renderStatus !== "ready" ||
    cover.editionNumber === null ||
    cover.contentHash === null ||
    cover.dmStoragePath === null
  ) {
    return null;
  }
  return {
    ok: true,
    outcome: "replayed",
    contentHash: cover.contentHash,
    editionNumber: cover.editionNumber,
    path: cover.dmStoragePath,
  };
}

async function loadPreflight(
  database: GuideCoverPublishDatabase,
  input: GuideCoverPublishInput,
): Promise<
  | {
      ok: true;
      cover: ResourceCoverVersion;
      presentation: ResourcePresentation;
      category: PresentationCategory;
    }
  | { ok: false; error: GuideCoverPublishError }
> {
  const cover = await database.resourceCoverVersion.findUnique({
    where: { id: input.coverVersionId },
  });
  if (
    !cover ||
    cover.resourceId !== input.resourceId ||
    cover.revision !== input.expectedRevision
  ) {
    return { ok: false, error: "cover_publish_conflict" };
  }
  const presentation = await database.resourcePresentation.findUnique({
    where: { resourceId: input.resourceId },
  });
  if (!presentation || presentation.categoryId !== cover.categoryId) {
    return { ok: false, error: "cover_publish_conflict" };
  }
  const category = await database.presentationCategory.findUnique({
    where: { id: cover.categoryId },
  });
  if (!category || category.designStatus !== "ready") {
    return { ok: false, error: "presentation_category_not_ready" };
  }
  return { ok: true, cover, presentation, category };
}

export function createGuideCoverPublishService(options: {
  database?: GuideCoverPublishDatabase;
  now?: () => Date;
  renderer?: Renderer;
  storage?: GuideCoverStorage;
} = {}) {
  const database = options.database ?? prisma;
  const now = options.now ?? (() => new Date());
  const renderer = options.renderer ?? renderGuideCoverPng;
  const storage = options.storage ?? createGuideCoverStorage();

  return {
    async approve(input: GuideCoverPublishInput): Promise<ApproveGuideCoverResult> {
      if (!validMutationInput(input)) {
        return { ok: false, error: "cover_invalid_input" };
      }
      let preflight;
      try {
        preflight = await loadPreflight(database, input);
      } catch {
        return { ok: false, error: "cover_publish_conflict" };
      }
      if (!preflight.ok) return preflight;
      if (preflight.cover.status === "approved") {
        return { ok: true, outcome: "replayed" };
      }
      if (preflight.cover.status !== "draft") {
        return { ok: false, error: "cover_publish_conflict" };
      }

      const editionNumber =
        preflight.presentation.editionNumber ??
        preflight.category.nextEditionNumber;
      const rendered = await renderer(
        renderInput(preflight.cover, preflight.category, editionNumber),
        "dm_cover",
      );
      if (!rendered.ok) return renderFailure(rendered);

      const approvedAt = now();
      try {
        const updated = await database.resourceCoverVersion.updateMany({
          where: {
            id: input.coverVersionId,
            resourceId: input.resourceId,
            revision: input.expectedRevision,
            status: "draft",
          },
          data: {
            status: "approved",
            approvedBy: input.actorId,
            approvedAt,
          },
        });
        if (updated.count !== 1) {
          return { ok: false, error: "cover_publish_conflict" };
        }
        return { ok: true, outcome: "approved" };
      } catch {
        return { ok: false, error: "cover_publish_conflict" };
      }
    },

    async publish(input: GuideCoverPublishInput): Promise<PublishGuideCoverResult> {
      if (!validMutationInput(input)) {
        return { ok: false, error: "cover_invalid_input" };
      }
      let preflight;
      try {
        const cover = await database.resourceCoverVersion.findUnique({
          where: { id: input.coverVersionId },
        });
        if (!cover) return { ok: false, error: "cover_publish_conflict" };
        const replay = exactPublishedReplay(cover, input);
        if (replay) return replay;
        preflight = await loadPreflight(database, input);
      } catch {
        return { ok: false, error: "cover_publish_conflict" };
      }
      if (!preflight.ok) return preflight;
      if (preflight.cover.status !== "approved") {
        return { ok: false, error: "cover_not_approved" };
      }

      const candidateEdition =
        preflight.presentation.editionNumber ??
        preflight.category.nextEditionNumber;
      const rendered = await renderer(
        renderInput(preflight.cover, preflight.category, candidateEdition),
        "dm_cover",
      );
      if (!rendered.ok) return renderFailure(rendered);

      const stored = await storage.upload({
        resourceId: input.resourceId,
        coverVersionId: input.coverVersionId,
        contentHash: rendered.value.contentHash,
        rendition: "dm_cover",
        png: rendered.value.png,
      });
      if (!stored.ok) return stored;

      const publishedAt = now();
      try {
        const result = await database.$transaction(async (tx) => {
          const categoryLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM presentation_category
            WHERE "id" = ${preflight.category.id}::uuid
              AND "design_status" = 'ready'
            FOR UPDATE
          `;
          if (categoryLock.length !== 1) throw new PublicationConflict();

          const presentationLock = await tx.$queryRaw<Array<{ resourceId: string }>>`
            SELECT "resource_id" AS "resourceId"
            FROM resource_presentation
            WHERE "resource_id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          if (presentationLock.length !== 1) throw new PublicationConflict();

          const coverLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM resource_cover_version
            WHERE "id" = ${input.coverVersionId}::uuid
            FOR UPDATE
          `;
          if (coverLock.length !== 1) throw new PublicationConflict();

          const lockedPresentation = await tx.resourcePresentation.findUnique({
            where: { resourceId: input.resourceId },
          });
          const lockedCover = await tx.resourceCoverVersion.findUnique({
            where: { id: input.coverVersionId },
          });
          if (
            !lockedPresentation ||
            lockedPresentation.categoryId !== preflight.category.id ||
            !lockedCover ||
            lockedCover.resourceId !== input.resourceId ||
            lockedCover.categoryId !== preflight.category.id ||
            lockedCover.revision !== input.expectedRevision ||
            lockedCover.status !== "approved"
          ) {
            throw new PublicationConflict();
          }

          let editionNumber = lockedPresentation.editionNumber;
          if (editionNumber === null) {
            const allocated = await tx.$queryRaw<Array<{ editionNumber: number }>>`
              UPDATE presentation_category
              SET "next_edition_number" = "next_edition_number" + 1,
                  "updated_at" = ${publishedAt}
              WHERE "id" = ${preflight.category.id}::uuid
                AND "next_edition_number" = ${candidateEdition}
              RETURNING "next_edition_number" - 1 AS "editionNumber"
            `;
            if (allocated.length !== 1 || !allocated[0]) {
              throw new PublicationConflict();
            }
            editionNumber = allocated[0].editionNumber;
            const assigned = await tx.resourcePresentation.updateMany({
              where: {
                resourceId: input.resourceId,
                categoryId: preflight.category.id,
                editionNumber: null,
              },
              data: { editionNumber },
            });
            if (assigned.count !== 1) throw new PublicationConflict();
          }
          if (editionNumber !== candidateEdition) throw new PublicationConflict();

          await tx.resourceCoverVersion.updateMany({
            where: {
              resourceId: input.resourceId,
              status: "published",
              id: { not: input.coverVersionId },
            },
            data: { status: "retired" },
          });
          const published = await tx.resourceCoverVersion.updateMany({
            where: {
              id: input.coverVersionId,
              resourceId: input.resourceId,
              categoryId: preflight.category.id,
              revision: input.expectedRevision,
              status: "approved",
            },
            data: {
              status: "published",
              renderStatus: "ready",
              editionNumber,
              contentHash: rendered.value.contentHash,
              dmStoragePath: stored.value.path,
              genericStoragePath: null,
              renderErrorCode: null,
              publishedBy: input.actorId,
              publishedAt,
            },
          });
          if (published.count !== 1) throw new PublicationConflict();
          return editionNumber;
        });

        return {
          ok: true,
          outcome: "published",
          contentHash: rendered.value.contentHash,
          editionNumber: result,
          path: stored.value.path,
          publicUrl: stored.value.publicUrl,
        };
      } catch {
        try {
          const reconciled = await database.resourceCoverVersion.findUnique({
            where: { id: input.coverVersionId },
          });
          const replay = reconciled ? exactPublishedReplay(reconciled, input) : null;
          if (
            replay?.ok &&
            replay.contentHash === rendered.value.contentHash &&
            replay.path === stored.value.path
          ) {
            return replay;
          }
        } catch (error) {
          if (isUniqueViolation(error)) {
            try {
              const orphan = await database.guideCoverOrphan.findUnique({
                where: { storagePath: stored.value.path },
              });
              if (
                orphan?.resourceId === input.resourceId &&
                orphan.coverVersionId === input.coverVersionId &&
                orphan.contentHash === rendered.value.contentHash &&
                orphan.rendition === "dm_cover"
              ) {
                return { ok: false, error: "cover_publish_conflict" };
              }
            } catch {
              // The exact-object reconciliation below intentionally fails closed.
            }
          }
          return { ok: false, error: "cover_storage_outcome_unknown" };
        }

        try {
          await database.guideCoverOrphan.create({
            data: {
              id: randomUUID(),
              resourceId: input.resourceId,
              coverVersionId: input.coverVersionId,
              contentHash: rendered.value.contentHash,
              rendition: "dm_cover",
              storagePath: stored.value.path,
            },
          });
        } catch {
          return { ok: false, error: "cover_storage_outcome_unknown" };
        }
        return { ok: false, error: "cover_publish_conflict" };
      }
    },
  };
}

export type GuideCoverPublishService = ReturnType<
  typeof createGuideCoverPublishService
>;
