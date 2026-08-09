import type { GraphErrorMetadata } from "./eventLogger.js";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "@prisma/client";

export type SettingsBlockedVerificationRejection =
  | "verification_missing"
  | "verification_stale"
  | "verification_retired"
  | "verification_mismatch";

export class SettingsBlockedVerificationError extends Error {
  constructor(public readonly reason: SettingsBlockedVerificationRejection) {
    super(`settings_blocked_verification_rejected:${reason}`);
    this.name = "SettingsBlockedVerificationError";
  }
}

const REJECTION_REASONS = new Set<SettingsBlockedVerificationRejection>([
  "verification_missing",
  "verification_stale",
  "verification_retired",
  "verification_mismatch",
]);

/** Reduce any thrown value to the closed, non-provider vocabulary safe for logs. */
export function settingsBlockedVerificationRejectionReason(
  error: unknown,
): SettingsBlockedVerificationRejection {
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? (error as { reason?: unknown }).reason
      : null;
  return typeof reason === "string" &&
    REJECTION_REASONS.has(reason as SettingsBlockedVerificationRejection)
    ? (reason as SettingsBlockedVerificationRejection)
    : "verification_missing";
}

export type SettingsBlockedVerificationEvidence = {
  verificationId: string;
  verificationVersion: string;
  graphCode: number;
  graphSubcode: number;
  classifiedAt: Date;
  verifiedAt: Date;
  validUntil: Date;
  evidenceReference: string;
  evidenceSha256: string;
};

function isGraphSignaturePart(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidSafeEvidence(record: {
  semanticCategory: string;
  evidenceReference: string;
  evidenceSha256: string;
  verifiedAt: Date;
  validUntil: Date;
}): boolean {
  return (
    record.semanticCategory === "settings_blocked" &&
    record.evidenceReference.trim().length > 0 &&
    /^[0-9a-f]{64}$/.test(record.evidenceSha256) &&
    record.validUntil.getTime() > record.verifiedAt.getTime()
  );
}

function toEvidence(
  record: {
    id: string;
    version: string;
    graphCode: number;
    graphSubcode: number;
    semanticCategory: string;
    verifiedAt: Date;
    validUntil: Date;
    evidenceReference: string;
    evidenceSha256: string;
  },
  classifiedAt: Date,
): SettingsBlockedVerificationEvidence {
  return {
    verificationId: record.id,
    verificationVersion: record.version,
    graphCode: record.graphCode,
    graphSubcode: record.graphSubcode,
    classifiedAt,
    verifiedAt: record.verifiedAt,
    validUntil: record.validUntil,
    evidenceReference: record.evidenceReference,
    evidenceSha256: record.evidenceSha256,
  };
}

/**
 * Resolve a controlled, active verification for the exact safe Graph signature.
 * The environment allowlist is a separate arming layer; neither is sufficient
 * on its own to schedule settings-specific public copy.
 */
export async function resolveActiveSettingsBlockedVerification(
  metadata: GraphErrorMetadata,
  classifiedAt = new Date(),
): Promise<SettingsBlockedVerificationEvidence> {
  if (
    !isGraphSignaturePart(metadata.graphCode) ||
    !isGraphSignaturePart(metadata.graphSubcode)
  ) {
    throw new SettingsBlockedVerificationError("verification_missing");
  }

  const record = await prisma.settingsBlockedVerification.findFirst({
    where: {
      graphCode: metadata.graphCode,
      graphSubcode: metadata.graphSubcode,
      active: true,
      retiredAt: null,
    },
    orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
  });

  if (!record) {
    throw new SettingsBlockedVerificationError("verification_missing");
  }
  if (record.validUntil.getTime() <= classifiedAt.getTime()) {
    throw new SettingsBlockedVerificationError("verification_stale");
  }
  if (record.verifiedAt.getTime() > classifiedAt.getTime()) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }
  if (!hasValidSafeEvidence(record)) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }

  return toEvidence(record, classifiedAt);
}

/**
 * Revalidate the frozen evidence immediately before persistence. This closes
 * the resolver-to-insert retirement/staleness gap and rejects a caller that
 * attempts to pair a real registry id with a different signature or hash.
 */
export async function validateSettingsBlockedVerificationEvidence(
  evidence: SettingsBlockedVerificationEvidence,
  now = new Date(),
): Promise<SettingsBlockedVerificationEvidence> {
  const record = await prisma.settingsBlockedVerification.findUnique({
    where: { id: evidence.verificationId },
  });

  if (!record) {
    throw new SettingsBlockedVerificationError("verification_missing");
  }
  if (!record.active || record.retiredAt !== null) {
    throw new SettingsBlockedVerificationError("verification_retired");
  }
  if (record.validUntil.getTime() <= now.getTime()) {
    throw new SettingsBlockedVerificationError("verification_stale");
  }
  if (record.verifiedAt.getTime() > now.getTime()) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }

  const exact =
    record.version === evidence.verificationVersion &&
    record.graphCode === evidence.graphCode &&
    record.graphSubcode === evidence.graphSubcode &&
    record.verifiedAt.getTime() === evidence.verifiedAt.getTime() &&
    record.validUntil.getTime() === evidence.validUntil.getTime() &&
    record.evidenceReference === evidence.evidenceReference &&
    record.evidenceSha256 === evidence.evidenceSha256 &&
    hasValidSafeEvidence(record);

  if (!exact) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }

  return evidence;
}

/**
 * Lock the referenced registry row through the caller's transaction and then
 * validate it. `FOR SHARE` conflicts with lifecycle UPDATE/DELETE, so retirement
 * cannot commit between this check and the reminder INSERT in the same transaction.
 */
export async function lockAndValidateSettingsBlockedVerificationEvidence(
  tx: Prisma.TransactionClient,
  evidence: SettingsBlockedVerificationEvidence,
  now = new Date(),
): Promise<SettingsBlockedVerificationEvidence> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      version: string;
      graphCode: number;
      graphSubcode: number;
      semanticCategory: string;
      verifiedAt: Date;
      validUntil: Date;
      evidenceReference: string;
      evidenceSha256: string;
      active: boolean;
      retiredAt: Date | null;
    }>
  >`
    SELECT
      "id",
      "version",
      "graph_code" AS "graphCode",
      "graph_subcode" AS "graphSubcode",
      "semantic_category" AS "semanticCategory",
      "verified_at" AS "verifiedAt",
      "valid_until" AS "validUntil",
      "evidence_reference" AS "evidenceReference",
      "evidence_sha256" AS "evidenceSha256",
      "active",
      "retired_at" AS "retiredAt"
    FROM "settings_blocked_verification"
    WHERE "id" = CAST(${evidence.verificationId} AS UUID)
    FOR SHARE
  `;
  const record = rows[0];
  if (!record) {
    throw new SettingsBlockedVerificationError("verification_missing");
  }
  if (!record.active || record.retiredAt !== null) {
    throw new SettingsBlockedVerificationError("verification_retired");
  }
  if (record.validUntil.getTime() <= now.getTime()) {
    throw new SettingsBlockedVerificationError("verification_stale");
  }
  if (record.verifiedAt.getTime() > now.getTime()) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }
  const exact =
    record.version === evidence.verificationVersion &&
    record.graphCode === evidence.graphCode &&
    record.graphSubcode === evidence.graphSubcode &&
    record.verifiedAt.getTime() === evidence.verifiedAt.getTime() &&
    record.validUntil.getTime() === evidence.validUntil.getTime() &&
    record.evidenceReference === evidence.evidenceReference &&
    record.evidenceSha256 === evidence.evidenceSha256 &&
    hasValidSafeEvidence(record);
  if (!exact) {
    throw new SettingsBlockedVerificationError("verification_mismatch");
  }
  return evidence;
}
