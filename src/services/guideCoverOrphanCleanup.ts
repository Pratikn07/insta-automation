import type { PrismaClient } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import {
  createGuideCoverCleanupStorage,
  validateGuideCoverObjectIdentity,
  type GuideCoverCleanupStorage,
} from "./guideCoverCleanupStorage.js";

const CLAIM_LEASE_MS = 10 * 60_000;
const RETRY_BASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

type ClaimedOrphan = {
  id: string;
  resourceId: string;
  coverVersionId: string;
  contentHash: string;
  rendition: string;
  storagePath: string;
  attempts: number;
  claimedAt: Date;
};

export type GuideCoverOrphanCleanupDatabase = Pick<
  PrismaClient,
  "$queryRaw" | "guideCoverOrphan"
>;

export interface GuideCoverOrphanCleanupResult {
  claimed: number;
  deleted: number;
  retried: number;
  needsReview: number;
}

function retryAt(now: Date, attempts: number): Date {
  const multiplier = 2 ** Math.max(0, attempts - 1);
  return new Date(now.getTime() + Math.min(24 * 60 * 60_000, RETRY_BASE_MS * multiplier));
}

export async function runGuideCoverOrphanCleanupTick(options: {
  database?: GuideCoverOrphanCleanupDatabase;
  storage?: GuideCoverCleanupStorage;
  batchSize: number;
  now?: () => Date;
}): Promise<GuideCoverOrphanCleanupResult> {
  const database = options.database ?? prisma;
  const storage = options.storage ?? createGuideCoverCleanupStorage();
  const now = options.now?.() ?? new Date();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
  const batchSize = Number.isFinite(options.batchSize)
    ? Math.max(1, Math.min(50, Math.trunc(options.batchSize)))
    : 1;

  const claimed = await database.$queryRaw<ClaimedOrphan[]>`
    WITH candidates AS (
      SELECT "id"
      FROM guide_cover_orphan
      WHERE (
          "status" = 'pending'
          AND "attempts" < ${MAX_ATTEMPTS}
          AND "next_attempt_at" <= ${now}
        ) OR (
          "status" = 'claimed'
          AND "attempts" <= ${MAX_ATTEMPTS}
          AND "claim_expires_at" <= ${now}
        )
      ORDER BY "next_attempt_at" ASC, "created_at" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE guide_cover_orphan AS orphan
    SET "status" = 'claimed',
        "attempts" = orphan."attempts" + CASE
          WHEN orphan."status" = 'pending' THEN 1
          ELSE 0
        END,
        "claimed_at" = ${now},
        "claim_expires_at" = ${claimExpiresAt},
        "updated_at" = ${now}
    FROM candidates
    WHERE orphan."id" = candidates."id"
    RETURNING
      orphan."id",
      orphan."resource_id" AS "resourceId",
      orphan."cover_version_id" AS "coverVersionId",
      orphan."content_hash" AS "contentHash",
      orphan."rendition",
      orphan."storage_path" AS "storagePath",
      orphan."attempts",
      orphan."claimed_at" AS "claimedAt"
  `;

  const result: GuideCoverOrphanCleanupResult = {
    claimed: claimed.length,
    deleted: 0,
    retried: 0,
    needsReview: 0,
  };

  for (const orphan of claimed) {
    const validPath = validateGuideCoverObjectIdentity({
      path: orphan.storagePath,
      resourceId: orphan.resourceId,
      coverVersionId: orphan.coverVersionId,
      contentHash: orphan.contentHash,
      rendition: orphan.rendition,
    });
    const removal = validPath
      ? await storage.removeExact(orphan.storagePath)
      : ({ ok: false, error: "cover_cleanup_invalid_path" } as const);

    if (removal.ok) {
      const checkpoint = await database.guideCoverOrphan.updateMany({
        where: { id: orphan.id, status: "claimed", claimedAt: orphan.claimedAt },
        data: {
          status: "deleted",
          deletedAt: now,
          lastErrorCode: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      if (checkpoint.count === 1) result.deleted += 1;
      continue;
    }

    const needsReview = !validPath || orphan.attempts >= MAX_ATTEMPTS;
    const checkpoint = await database.guideCoverOrphan.updateMany({
      where: { id: orphan.id, status: "claimed", claimedAt: orphan.claimedAt },
      data: {
        status: needsReview ? "needs_review" : "pending",
        attempts: orphan.attempts,
        lastErrorCode: removal.error,
        nextAttemptAt: needsReview ? now : retryAt(now, orphan.attempts),
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (checkpoint.count !== 1) continue;
    if (needsReview) result.needsReview += 1;
    else result.retried += 1;
  }

  return result;
}
