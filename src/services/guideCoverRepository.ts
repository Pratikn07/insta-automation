import type {
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
  "resourcePresentation" | "resourceCoverVersion"
>;

type ReplayResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | {
      ok: false;
      error:
        | "cover_create_conflict"
        | "cover_invalid_input"
        | "cover_repository_unavailable";
    };

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
    stored.categoryId === input.categoryId &&
    stored.editionNumber === null
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
    stored.revision === 1 &&
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
        if (!stored || !isExactPresentationReplay(stored, input)) {
          return { ok: false, error: "cover_create_conflict" };
        }
        return { ok: true, value: stored, replayed: true };
      }
    },

    async createOrLoadDraft(
      input: CreateGuideCoverDraftInput,
    ): Promise<ReplayResult<ResourceCoverVersion>> {
      const copy = normalizedCopy(input.copy);
      if (!copy) return { ok: false, error: "cover_invalid_input" };

      try {
        const value = await database.resourceCoverVersion.create({
          data: {
            id: input.id,
            resourceId: input.resourceId,
            revision: 1,
            categoryId: input.categoryId,
            templateKey: input.templateKey,
            paletteKey: input.paletteKey,
            illustrationKey: input.illustrationKey,
            suggestionId: input.suggestionId,
            ...copy,
          },
        });
        return { ok: true, value, replayed: false };
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
        const updated = await database.resourceCoverVersion.updateMany({
          where: {
            id: input.id,
            resourceId: input.resourceId,
            revision: input.expectedRevision,
            status: "draft",
          },
          data: { revision: input.expectedRevision + 1, ...copy },
        });
        if (updated.count !== 1) {
          return { ok: false, error: "cover_revision_conflict" };
        }
        const value = await database.resourceCoverVersion.findUnique({
          where: { id: input.id },
        });
        if (!value) return { ok: false, error: "cover_repository_unavailable" };
        return { ok: true, value };
      } catch {
        return { ok: false, error: "cover_repository_unavailable" };
      }
    },

    findPublished(resourceId: string): Promise<ResourceCoverVersion | null> {
      return database.resourceCoverVersion.findFirst({
        where: {
          resourceId,
          status: "published",
          renderStatus: "ready",
          contentHash: { not: null },
          dmStoragePath: { not: null },
        },
      });
    },
  };
}

export type GuideCoverRepository = ReturnType<typeof createGuideCoverRepository>;
