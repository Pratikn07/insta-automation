import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type SettingsBlockedVerificationAdminRejection =
  | "verification_missing"
  | "verification_stale"
  | "verification_retired"
  | "verification_invalid"
  | "verification_conflict"
  | "retirement_reason_invalid";

export class SettingsBlockedVerificationAdminError extends Error {
  constructor(public readonly reason: SettingsBlockedVerificationAdminRejection) {
    super(`settings_blocked_verification_admin_rejected:${reason}`);
    this.name = "SettingsBlockedVerificationAdminError";
  }
}

function validTarget(target: {
  version: string;
  graphCode: number;
  graphSubcode: number;
  semanticCategory: string;
  verifiedAt: Date;
  validUntil: Date;
  evidenceReference: string;
  evidenceSha256: string;
}): boolean {
  return (
    target.semanticCategory === "settings_blocked" &&
    Number.isSafeInteger(target.graphCode) &&
    target.graphCode >= 0 &&
    Number.isSafeInteger(target.graphSubcode) &&
    target.graphSubcode >= 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.version) &&
    target.validUntil.getTime() > target.verifiedAt.getTime() &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(target.evidenceReference) &&
    !target.evidenceReference.includes("..") &&
    /^[0-9a-f]{64}$/.test(target.evidenceSha256)
  );
}

function safeActor(actor: string | null | undefined): string {
  const trimmed = actor?.trim().slice(0, 100) ?? "unknown_admin";
  return trimmed || "unknown_admin";
}

function rethrowAdminTransactionError(error: unknown): never {
  if (error instanceof SettingsBlockedVerificationAdminError) throw error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  if (code === "P2002" || code === "P2034") {
    throw new SettingsBlockedVerificationAdminError("verification_conflict");
  }
  throw error;
}

export async function activateSettingsBlockedVerification(
  id: string,
  actor: string | null | undefined,
  now = new Date(),
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
      const target = await tx.settingsBlockedVerification.findUnique({ where: { id } });
      if (!target) throw new SettingsBlockedVerificationAdminError("verification_missing");
      if (target.retiredAt) {
        throw new SettingsBlockedVerificationAdminError("verification_retired");
      }
      if (target.validUntil.getTime() <= now.getTime()) {
        throw new SettingsBlockedVerificationAdminError("verification_stale");
      }
      if (target.verifiedAt.getTime() > now.getTime()) {
        throw new SettingsBlockedVerificationAdminError("verification_invalid");
      }
      if (!validTarget(target)) {
        throw new SettingsBlockedVerificationAdminError("verification_invalid");
      }
      if (target.active) return;

      await tx.settingsBlockedVerification.updateMany({
        where: {
          graphCode: target.graphCode,
          graphSubcode: target.graphSubcode,
          active: true,
          retiredAt: null,
          id: { not: target.id },
        },
        data: {
          active: false,
          retiredAt: now,
          retirementReason: `superseded_by:${target.id}:${safeActor(actor)}`,
        },
      });

      const activated = await tx.settingsBlockedVerification.updateMany({
        where: {
          id: target.id,
          active: false,
          retiredAt: null,
          validUntil: { gt: now },
        },
        data: { active: true },
      });
      if (activated.count !== 1) {
        throw new SettingsBlockedVerificationAdminError("verification_conflict");
      }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    rethrowAdminTransactionError(error);
  }
}

export async function retireSettingsBlockedVerification(
  id: string,
  reason: string,
  actor: string | null | undefined,
  now = new Date(),
): Promise<void> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 200) {
    throw new SettingsBlockedVerificationAdminError("retirement_reason_invalid");
  }

  try {
    await prisma.$transaction(
      async (tx) => {
      const retired = await tx.settingsBlockedVerification.updateMany({
        where: { id, active: true, retiredAt: null },
        data: {
          active: false,
          retiredAt: now,
          retirementReason: `${trimmedReason} (${safeActor(actor)})`,
        },
      });
      if (retired.count !== 1) {
        const existing = await tx.settingsBlockedVerification.findUnique({ where: { id } });
        throw new SettingsBlockedVerificationAdminError(
          existing ? "verification_conflict" : "verification_missing",
        );
      }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    rethrowAdminTransactionError(error);
  }
}
