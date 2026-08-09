import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/**
 * Serialize every writer that can create or settle a person-keyword journey.
 * Two signed 32-bit keys are derived in application code so the lock identity
 * stays stable across PostgreSQL versions and processes.
 */
export async function lockJourneyIdentity(
  tx: Prisma.TransactionClient,
  igUserId: string,
  keywordId: string,
): Promise<void> {
  const digest = createHash("sha256")
    .update(igUserId)
    .update("\u0000")
    .update(keywordId)
    .digest();
  const namespaceKey = digest.readInt32BE(0);
  const identityKey = digest.readInt32BE(4);
  await tx.$queryRaw`
    SELECT 1::int AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock(${namespaceKey}::int, ${identityKey}::int)
    ) AS acquired
  `;
}
