import type {
  Prisma,
  PrismaClient,
  ResourceCoverVersion,
  ResourcePresentation,
} from "@prisma/client";

import {
  validateGuideCoverCategoryText,
  validateGuideCoverDraft,
  type GuideCoverDraft,
} from "../../shared/guideCoverPolicy.js";
import { prisma } from "../lib/prisma.js";

export type GuideCoverDatabase = Pick<
  PrismaClient,
  "$transaction" | "resourcePresentation" | "resourceCoverVersion"
>;

type ReplayResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | {
      ok: false;
      error:
        | "cover_category_locked_by_publication"
        | "cover_create_conflict"
        | "cover_invalid_input"
        | "cover_repository_unavailable";
    };

export type PresentationRepointResult =
  | { ok: true; outcome: "moved" | "unchanged" }
  | {
      ok: false;
      error:
        | "cover_category_locked_by_publication"
        | "cover_create_conflict"
        | "cover_repository_unavailable";
    };

type PresentationWriter = Pick<
  GuideCoverDatabase,
  "resourcePresentation" | "resourceCoverVersion"
>;

type SaveDraftResult =
  | { ok: true; value: ResourceCoverVersion }
  | {
      ok: false;
      error:
        | "cover_invalid_input"
        | "cover_repository_unavailable"
        | "cover_revision_conflict";
    };

export interface CreateGuideCoverDraftInput {
  id: string;
  resourceId: string;
  categoryId: string;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
  suggestionId: string | null;
  copy: GuideCoverDraft & { kicker: string; collectionLabel: string };
}

export interface SaveGuideCoverDraftInput {
  id: string;
  resourceId: string;
  expectedRevision: number;
  copy: GuideCoverDraft & { kicker: string; collectionLabel: string };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002",
  );
}

function normalizedCopy(
  copy: GuideCoverDraft & { kicker: string; collectionLabel: string },
): (GuideCoverDraft & { kicker: string; collectionLabel: string }) | null {
  const draft = validateGuideCoverDraft(copy);
  if (!draft.ok) return null;
  const categoryText = validateGuideCoverCategoryText(copy);
  if (!categoryText.ok) return null;
  return { ...draft.value, ...categoryText.value };
}

function isExactPresentationReplay(
  stored: ResourcePresentation,
  input: { resourceId: string; categoryId: string },
): boolean {
  return (
    stored.resourceId === input.resourceId &&
    stored.categoryId === input.categoryId
  );
}

function isExactDraftReplay(
  stored: ResourceCoverVersion,
  input: CreateGuideCoverDraftInput,
  copy: GuideCoverDraft & { kicker: string; collectionLabel: string },
): boolean {
  return (
    stored.id === input.id &&
    stored.resourceId === input.resourceId &&
    stored.status === "draft" &&
    stored.renderStatus === "not_rendered" &&
    stored.categoryId === input.categoryId &&
    stored.templateKey === input.templateKey &&
    stored.paletteKey === input.paletteKey &&
    stored.illustrationKey === input.illustrationKey &&
    stored.suggestionId === input.suggestionId &&
    stored.kicker === copy.kicker &&
    stored.collectionLabel === copy.collectionLabel &&
    stored.headline === copy.headline &&
    stored.supportingLine === copy.supportingLine &&
    stored.closingLine === copy.closingLine &&
    stored.alternativeDescription === copy.alternativeDescription
  );
}

/**
 * Points a guide that has never been published at a different collection.
 *
 * The edition number is a per-collection sequence, so a presentation row is only free to
 * move while it has none. Once one is stamped, the guide belongs to that collection's
 * numbering and only the audited collection move may take it out — which is why this
 * refuses rather than reassigning, and why the update is a compare-and-swap on a null
 * edition even under the caller's lock.
 *
 * Draft and approved covers carry the old collection's kicker, label and visual keys and
 * can never be published once the presentation points elsewhere. They are retired here so
 * the editor cannot pick one up as the working cover of a collection it does not belong
 * to; the rows stay for history. Retiring only relaxes the one-published-row index, and a
 * null edition cannot collide with the partial unique on (category, edition).
 */
async function repointUnpublishedPresentation(
  database: PresentationWriter,
  presentation: ResourcePresentation,
  toCategoryId: string,
): Promise<PresentationRepointResult> {
  if (presentation.categoryId === toCategoryId) {
    return { ok: true, outcome: "unchanged" };
  }
  if (presentation.editionNumber !== null) {
    return { ok: false, error: "cover_category_locked_by_publication" };
  }
  const published = await database.resourceCoverVersion.findFirst({
    where: { resourceId: presentation.resourceId, status: "published" },
    select: { id: true },
  });
  if (published) {
    return { ok: false, error: "cover_category_locked_by_publication" };
  }

  // The move commits before anything is retired: a lost compare-and-swap must leave the
  // guide exactly as it was, and returning from a transaction callback commits it.
  const moved = await database.resourcePresentation.updateMany({
    where: {
      resourceId: presentation.resourceId,
      categoryId: presentation.categoryId,
      editionNumber: null,
    },
    data: { categoryId: toCategoryId },
  });
  if (moved.count !== 1) return { ok: false, error: "cover_create_conflict" };

  await database.resourceCoverVersion.updateMany({
    where: {
      resourceId: presentation.resourceId,
      categoryId: presentation.categoryId,
      status: { in: ["draft", "approved"] },
    },
    data: { status: "retired" },
  });
  return { ok: true, outcome: "moved" };
}

/**
 * The single definition of "a cover a parent may actually be sent".
 *
 * `published` alone is not enough: the row must also have rendered, and it must have a
 * stored DM path and content hash, or there is nothing immutable to send. This lives
 * here and is shared with the guide-access attempt transaction so the two cannot drift
 * on what counts as sendable — a second, subtly different copy of this predicate is how
 * a draft cover would eventually reach a parent.
 *
 * `resource_cover_version_one_published_key` permits one published row per resource, so
 * a `findFirst` on this predicate is deterministic rather than arbitrary.
 */
export function publishedCoverWhere(
  resourceId: string,
): Prisma.ResourceCoverVersionWhereInput {
  return {
    resourceId,
    status: "published",
    renderStatus: "ready",
    contentHash: { not: null },
    dmStoragePath: { not: null },
  } as const;
}

export function createGuideCoverRepository(options: {
  database?: GuideCoverDatabase;
} = {}) {
  const database = options.database ?? prisma;

  return {
    async createOrLoadPresentation(input: {
      resourceId: string;
      categoryId: string;
    }): Promise<ReplayResult<ResourcePresentation>> {
      try {
        const value = await database.resourcePresentation.create({ data: input });
        return { ok: true, value, replayed: false };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          return { ok: false, error: "cover_repository_unavailable" };
        }
        const stored = await database.resourcePresentation.findUnique({
          where: { resourceId: input.resourceId },
        });
        if (!stored) return { ok: false, error: "cover_create_conflict" };
        // A row for another collection is not a failure here — this only guarantees the
        // guide has a presentation. Whether it may move to `input.categoryId` is decided
        // under the presentation lock, where the old collection's covers can be retired
        // with it in one transaction.
        return {
          ok: true,
          value: stored,
          replayed: isExactPresentationReplay(stored, input),
        };
      }
    },

    async createOrLoadDraft(
      input: CreateGuideCoverDraftInput,
    ): Promise<ReplayResult<ResourceCoverVersion>> {
      const copy = normalizedCopy(input.copy);
      if (!copy) return { ok: false, error: "cover_invalid_input" };

      try {
        const existing = await database.resourceCoverVersion.findUnique({
          where: { id: input.id },
        });
        if (existing) {
          if (!isExactDraftReplay(existing, input, copy)) {
            return { ok: false, error: "cover_create_conflict" };
          }
          return { ok: true, value: existing, replayed: true };
        }

        return await database.$transaction(async (tx) => {
          const resourceLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM resources
            WHERE "id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          if (resourceLock.length !== 1) {
            return { ok: false, error: "cover_create_conflict" } as const;
          }

          // Every new revision for one resource serializes on its presentation.
          // The edition is backend-owned and may already be allocated; only the
          // resource/category identity is part of this create intent.
          const presentationLock = await tx.$queryRaw<Array<{ resourceId: string }>>`
            SELECT "resource_id" AS "resourceId"
            FROM resource_presentation
            WHERE "resource_id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          if (presentationLock.length !== 1) {
            return { ok: false, error: "cover_create_conflict" } as const;
          }
          const presentation = await tx.resourcePresentation.findUnique({
            where: { resourceId: input.resourceId },
          });
          if (!presentation) {
            return { ok: false, error: "cover_create_conflict" } as const;
          }
          // Saving a draft under a different collection is how a creator changes their
          // mind, and it stays one atomic act: either the guide moves and this revision
          // exists, or neither happened.
          const repointed = await repointUnpublishedPresentation(
            tx,
            presentation,
            input.categoryId,
          );
          if (!repointed.ok) return { ok: false, error: repointed.error } as const;

          const replay = await tx.resourceCoverVersion.findUnique({
            where: { id: input.id },
          });
          if (replay) {
            if (!isExactDraftReplay(replay, input, copy)) {
              return { ok: false, error: "cover_create_conflict" } as const;
            }
            return { ok: true, value: replay, replayed: true } as const;
          }

          const allocated = await tx.$queryRaw<Array<{ revision: number }>>`
            SELECT COALESCE(MAX("revision"), 0) + 1 AS "revision"
            FROM resource_cover_version
            WHERE "resource_id" = ${input.resourceId}::uuid
          `;
          const revision = allocated[0]?.revision;
          if (!revision || !Number.isSafeInteger(revision)) {
            return { ok: false, error: "cover_repository_unavailable" } as const;
          }
          const value = await tx.resourceCoverVersion.create({
            data: {
              id: input.id,
              resourceId: input.resourceId,
              revision,
              categoryId: input.categoryId,
              templateKey: input.templateKey,
              paletteKey: input.paletteKey,
              illustrationKey: input.illustrationKey,
              suggestionId: input.suggestionId,
              ...copy,
            },
          });
          return { ok: true, value, replayed: false } as const;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          return { ok: false, error: "cover_repository_unavailable" };
        }
        const stored = await database.resourceCoverVersion.findUnique({
          where: { id: input.id },
        });
        if (!stored || !isExactDraftReplay(stored, input, copy)) {
          return { ok: false, error: "cover_create_conflict" };
        }
        return { ok: true, value: stored, replayed: true };
      }
    },

    async saveDraft(input: SaveGuideCoverDraftInput): Promise<SaveDraftResult> {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        return { ok: false, error: "cover_invalid_input" };
      }
      const copy = normalizedCopy(input.copy);
      if (!copy) return { ok: false, error: "cover_invalid_input" };

      try {
        const nextRevision = await database.$transaction(async (tx) => {
          const resourceLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM resources
            WHERE "id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          const presentationLock = await tx.$queryRaw<Array<{ resourceId: string }>>`
            SELECT "resource_id" AS "resourceId" FROM resource_presentation
            WHERE "resource_id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          const coverLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM resource_cover_version
            WHERE "id" = ${input.id}::uuid
            FOR UPDATE
          `;
          if (
            resourceLock.length !== 1 ||
            presentationLock.length !== 1 ||
            coverLock.length !== 1
          ) {
            return null;
          }
          const stored = await tx.resourceCoverVersion.findUnique({
            where: { id: input.id },
          });
          if (
            !stored ||
            stored.resourceId !== input.resourceId ||
            stored.revision !== input.expectedRevision ||
            stored.status !== "draft"
          ) {
            return null;
          }
          const allocated = await tx.$queryRaw<Array<{ revision: number }>>`
            SELECT COALESCE(MAX("revision"), 0) + 1 AS "revision"
            FROM resource_cover_version
            WHERE "resource_id" = ${input.resourceId}::uuid
          `;
          const revision = allocated[0]?.revision;
          if (!revision || !Number.isSafeInteger(revision)) {
            throw new Error("cover_revision_allocation_failed");
          }
          const updated = await tx.resourceCoverVersion.updateMany({
            where: {
              id: input.id,
              resourceId: input.resourceId,
              revision: input.expectedRevision,
              status: "draft",
            },
            data: { revision, ...copy },
          });
          return updated.count === 1 ? revision : null;
        });
        if (nextRevision === null) {
          return { ok: false, error: "cover_revision_conflict" };
        }
        const value = await database.resourceCoverVersion.findUnique({
          where: { id: input.id },
        });
        if (!value) return { ok: false, error: "cover_repository_unavailable" };
        return { ok: true, value };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, error: "cover_revision_conflict" };
        }
        return { ok: false, error: "cover_repository_unavailable" };
      }
    },

    /**
     * Moves a guide to another collection on its own, for callers that are not also
     * writing a cover revision. Same policy, same locks as the draft path.
     */
    async repointPresentation(input: {
      resourceId: string;
      toCategoryId: string;
    }): Promise<PresentationRepointResult> {
      try {
        return await database.$transaction(async (tx) => {
          const resourceLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM resources
            WHERE "id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          const presentationLock = await tx.$queryRaw<Array<{ resourceId: string }>>`
            SELECT "resource_id" AS "resourceId"
            FROM resource_presentation
            WHERE "resource_id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          if (resourceLock.length !== 1 || presentationLock.length !== 1) {
            return { ok: false, error: "cover_create_conflict" } as const;
          }
          const presentation = await tx.resourcePresentation.findUnique({
            where: { resourceId: input.resourceId },
          });
          if (!presentation) {
            return { ok: false, error: "cover_create_conflict" } as const;
          }
          return repointUnpublishedPresentation(tx, presentation, input.toCategoryId);
        });
      } catch {
        return { ok: false, error: "cover_repository_unavailable" };
      }
    },

    findPublished(resourceId: string): Promise<ResourceCoverVersion | null> {
      return database.resourceCoverVersion.findFirst({
        where: publishedCoverWhere(resourceId),
      });
    },
  };
}

export type GuideCoverRepository = ReturnType<typeof createGuideCoverRepository>;
