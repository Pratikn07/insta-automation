import type { PrismaClient } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export type GuideCoverCollectionMoveDatabase = Pick<PrismaClient, "$transaction">;

export interface GuideCoverCollectionMoveInput {
  actorId: string;
  resourceId: string;
  expectedCategoryId: string;
  targetCategoryId: string;
  expectedPublishedCoverId: string;
  expectedPublishedCoverRevision: number;
}

export type GuideCoverCollectionMoveResult =
  | { ok: true; outcome: "moved"; editionNumber: number }
  | {
      ok: false;
      error:
        | "cover_collection_move_invalid_input"
        | "cover_collection_move_conflict"
        | "presentation_category_not_ready";
    };

class CollectionMoveConflict extends Error {}

function validInput(input: GuideCoverCollectionMoveInput): boolean {
  return (
    input.actorId.trim().length > 0 &&
    input.resourceId.length > 0 &&
    input.expectedCategoryId.length > 0 &&
    input.targetCategoryId.length > 0 &&
    input.expectedCategoryId !== input.targetCategoryId &&
    input.expectedPublishedCoverId.length > 0 &&
    Number.isSafeInteger(input.expectedPublishedCoverRevision) &&
    input.expectedPublishedCoverRevision >= 1
  );
}

export function createGuideCoverCollectionMoveService(options: {
  database?: GuideCoverCollectionMoveDatabase;
} = {}) {
  const database = options.database ?? prisma;

  return {
    async move(
      input: GuideCoverCollectionMoveInput,
    ): Promise<GuideCoverCollectionMoveResult> {
      if (!validInput(input)) {
        return { ok: false, error: "cover_collection_move_invalid_input" };
      }

      try {
        return await database.$transaction(async (tx) => {
          const resourceLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM resources
            WHERE "id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          if (resourceLock.length !== 1) throw new CollectionMoveConflict();

          // Keep this order stable across every publication mutation: resource,
          // target category, presentation, then the historical cover row.
          const targetLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM presentation_category
            WHERE "id" = ${input.targetCategoryId}::uuid
              AND "design_status" = 'ready'
            FOR UPDATE
          `;
          if (targetLock.length !== 1) {
            return { ok: false, error: "presentation_category_not_ready" } as const;
          }

          const presentationLock = await tx.$queryRaw<Array<{ resourceId: string }>>`
            SELECT "resource_id" AS "resourceId"
            FROM resource_presentation
            WHERE "resource_id" = ${input.resourceId}::uuid
            FOR UPDATE
          `;
          const coverLock = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM resource_cover_version
            WHERE "id" = ${input.expectedPublishedCoverId}::uuid
            FOR UPDATE
          `;
          if (presentationLock.length !== 1 || coverLock.length !== 1) {
            throw new CollectionMoveConflict();
          }

          const [target, presentation, historicalCover] = await Promise.all([
            tx.presentationCategory.findUnique({
              where: { id: input.targetCategoryId },
            }),
            tx.resourcePresentation.findUnique({
              where: { resourceId: input.resourceId },
            }),
            tx.resourceCoverVersion.findUnique({
              where: { id: input.expectedPublishedCoverId },
            }),
          ]);
          if (!target || target.designStatus !== "ready" || !presentation || !historicalCover) {
            throw new CollectionMoveConflict();
          }

          if (
            presentation.categoryId !== input.expectedCategoryId ||
            presentation.editionNumber === null ||
            historicalCover.resourceId !== input.resourceId ||
            historicalCover.categoryId !== input.expectedCategoryId ||
            historicalCover.editionNumber !== presentation.editionNumber ||
            historicalCover.revision !== input.expectedPublishedCoverRevision ||
            historicalCover.status !== "published"
          ) {
            throw new CollectionMoveConflict();
          }

          const priorEdition = presentation.editionNumber;
          const allocated = await tx.$queryRaw<Array<{ editionNumber: number }>>`
            UPDATE presentation_category
            SET "next_edition_number" = "next_edition_number" + 1,
                "updated_at" = NOW()
            WHERE "id" = ${input.targetCategoryId}::uuid
              AND "design_status" = 'ready'
            RETURNING "next_edition_number" - 1 AS "editionNumber"
          `;
          const editionNumber = allocated[0]?.editionNumber;
          if (editionNumber === undefined) throw new CollectionMoveConflict();

          const moved = await tx.resourcePresentation.updateMany({
            where: {
              resourceId: input.resourceId,
              categoryId: input.expectedCategoryId,
              editionNumber: priorEdition,
            },
            data: {
              categoryId: input.targetCategoryId,
              editionNumber,
            },
          });
          const retired = await tx.resourceCoverVersion.updateMany({
            where: {
              id: input.expectedPublishedCoverId,
              resourceId: input.resourceId,
              categoryId: input.expectedCategoryId,
              editionNumber: priorEdition,
              revision: input.expectedPublishedCoverRevision,
              status: "published",
            },
            data: { status: "retired" },
          });
          if (moved.count !== 1 || retired.count !== 1) {
            throw new CollectionMoveConflict();
          }

          return { ok: true, outcome: "moved", editionNumber } as const;
        });
      } catch {
        return { ok: false, error: "cover_collection_move_conflict" };
      }
    },
  };
}

export type GuideCoverCollectionMoveService = ReturnType<
  typeof createGuideCoverCollectionMoveService
>;
