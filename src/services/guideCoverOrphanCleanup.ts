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
  reclaimed: boolean;
};

export type GuideCoverOrphanCleanupDatabase = Pick<
  PrismaClient,
  "$queryRaw" | "guideCoverOrphan" | "resourceCoverVersion"
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

function storedErrorCode(error: string): string {
  if (error === "cover_cleanup_invalid_path") return "storage_path_invalid";
  if (error === "cover_cleanup_outcome_unknown") return "storage_outcome_unknown";
  return "storage_delete_failed";
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
      SELECT orphan."id", orphan."status" AS "priorStatus"
      FROM guide_cover_orphan AS orphan
      WHERE (
        (
            orphan."status" = 'pending'
            AND orphan."attempts" < ${MAX_ATTEMPTS}
            AND orphan."next_attempt_at" <= ${now}
          ) OR (
            orphan."status" = 'claimed'
            AND orphan."attempts" <= ${MAX_ATTEMPTS}
            AND orphan."claim_expires_at" <= ${now}
          )
        )
      AND NOT EXISTS (
        SELECT 1
        FROM resource_cover_version AS cover
        WHERE cover."status" IN ('published', 'retired')
          AND (
            (
              orphan."rendition" = 'dm_cover'
              AND cover."dm_storage_path" = orphan."storage_path"
            ) OR (
              orphan."rendition" = 'generic_card'
              AND cover."generic_storage_path" = orphan."storage_path"
            )
          )
      )
      ORDER BY orphan."next_attempt_at" ASC, orphan."created_at" ASC
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
      orphan."claimed_at" AS "claimedAt",
      (candidates."priorStatus" = 'claimed') AS "reclaimed"
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
    const livePathWhere = orphan.rendition === "dm_cover"
      ? { dmStoragePath: orphan.storagePath }
      : orphan.rendition === "generic_card"
        ? { genericStoragePath: orphan.storagePath }
        : null;
    const liveCoverCount = validPath && livePathWhere
      ? await database.resourceCoverVersion.count({
          where: {
            resourceId: orphan.resourceId,
            id: orphan.coverVersionId,
            contentHash: orphan.contentHash,
            ...livePathWhere,
            renderStatus: "ready",
            status: { in: ["published", "retired"] },
          },
        })
      : 0;

    if (liveCoverCount > 0) {
      const checkpoint = await database.guideCoverOrphan.updateMany({
        where: { id: orphan.id, status: "claimed", claimedAt: orphan.claimedAt },
        data: {
          status: "needs_review",
          attempts: orphan.attempts,
          lastErrorCode: "storage_path_live",
          nextAttemptAt: now,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      if (checkpoint.count === 1) result.needsReview += 1;
      continue;
    }

    let removal:
      | Awaited<ReturnType<GuideCoverCleanupStorage["removeExact"]>>
      | { ok: true; outcome: "already_missing" };
    if (!validPath) {
      removal = { ok: false, error: "cover_cleanup_invalid_path" };
    } else if (orphan.reclaimed) {
      const probe = await storage.probeExact(orphan.storagePath);
      if (!probe.ok) removal = probe;
      else if (!probe.exists) removal = { ok: true, outcome: "already_missing" };
      else removal = await storage.removeExact(orphan.storagePath);
    } else {
      removal = await storage.removeExact(orphan.storagePath);
    }

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
        lastErrorCode: storedErrorCode(removal.error),
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
