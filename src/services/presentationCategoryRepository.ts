import type { PresentationCategory, PrismaClient } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export type PresentationCategoryDatabase = Pick<
  PrismaClient,
  "presentationCategory"
>;

export interface CreatePresentationCategoryInput {
  id: string;
  slug: string;
  name: string;
  collectionLabel: string;
  defaultKicker: string;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
  designStatus: "ready" | "needs_review" | "inactive";
  sortOrder: number | null;
  createdBy: string;
  updatedBy: string;
}

export type CreatePresentationCategoryResult =
  | { ok: true; value: PresentationCategory; replayed: boolean }
  | {
      ok: false;
      error:
        | "presentation_category_duplicate"
        | "presentation_category_repository_unavailable";
    };

const IDENTITY_FIELDS = [
  "id",
  "slug",
  "name",
  "collectionLabel",
  "defaultKicker",
  "templateKey",
  "paletteKey",
  "illustrationKey",
  "designStatus",
  "sortOrder",
  "createdBy",
] as const satisfies ReadonlyArray<keyof CreatePresentationCategoryInput>;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002",
  );
}

function isExactReplay(
  stored: PresentationCategory,
  input: CreatePresentationCategoryInput,
): boolean {
  return IDENTITY_FIELDS.every((field) => stored[field] === input[field]);
}

export function createPresentationCategoryRepository(options: {
  database?: PresentationCategoryDatabase;
} = {}) {
  const database = options.database ?? prisma;

  return {
    async createOrLoad(
      input: CreatePresentationCategoryInput,
    ): Promise<CreatePresentationCategoryResult> {
      try {
        const value = await database.presentationCategory.create({
          data: {
            id: input.id,
            slug: input.slug,
            name: input.name,
            collectionLabel: input.collectionLabel,
            defaultKicker: input.defaultKicker,
            templateKey: input.templateKey,
            paletteKey: input.paletteKey,
            illustrationKey: input.illustrationKey,
            designStatus: input.designStatus,
            sortOrder: input.sortOrder,
            createdBy: input.createdBy,
            updatedBy: input.updatedBy,
          },
        });
        return { ok: true, value, replayed: false };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          return {
            ok: false,
            error: "presentation_category_repository_unavailable",
          };
        }

        const stored = await database.presentationCategory.findUnique({
          where: { id: input.id },
        });
        if (!stored || !isExactReplay(stored, input)) {
          return { ok: false, error: "presentation_category_duplicate" };
        }
        return { ok: true, value: stored, replayed: true };
      }
    },

    list(includeInactive = false): Promise<PresentationCategory[]> {
      return database.presentationCategory.findMany({
        where: includeInactive ? undefined : { designStatus: { not: "inactive" } },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
    },

    findReadyById(id: string): Promise<PresentationCategory | null> {
      return database.presentationCategory.findFirst({
        where: { id, designStatus: "ready" },
      });
    },
  };
}

export type PresentationCategoryRepository = ReturnType<
  typeof createPresentationCategoryRepository
>;
