import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

export type DispatchSourceKind = "prospective" | "historical";

export type DispatchBlockReason =
  | "stale_claim"
  | "circuit_open"
  | "person_reservation_active"
  | "person_cooldown"
  | "hourly_cap_reached"
  | "daily_cap_reached"
  | "global_hourly_cap_reached"
  | "source_attempt_exists"
  | "reconciled_alias";

export type DispatchReservation =
  | { kind: "reserved"; dispatchId: string; reservationToken: string }
  | { kind: "blocked"; reason: DispatchBlockReason };

export type ReserveDispatchInput = {
  sourceKind: DispatchSourceKind;
  sourceId: string;
  attemptNumber: number;
  igUserId: string;
  campaignId: string | null;
  now: Date;
  leaseExpiresAt: Date;
  prospectiveCooldownHours: number;
  globalHourlyCap: number;
  campaignHourlyCap?: number;
  campaignDailyCap?: number;
};

const ACTIVE_STATES = ["reserved", "dispatch_started"] as const;
const CAPACITY_STATES = ["reserved", "dispatch_started", "sent", "uncertain"] as const;
const TERMINAL_CONTACT_STATES = ["sent", "uncertain"] as const;

/**
 * Reserve under locks already acquired by the feature repository.
 *
 * The caller must hold dm_recovery_control(1), then ig_users(person), then its source
 * row. Keeping lock acquisition outside this helper makes source validation and ledger
 * insertion one transaction without allowing either feature to reverse the order.
 */
export async function reservePublicRecoveryDispatch(
  tx: Prisma.TransactionClient,
  input: ReserveDispatchInput,
): Promise<DispatchReservation> {
  const existingSourceAttempt = await tx.publicRecoveryDispatch.findUnique({
    where: {
      sourceKind_sourceId_attemptNumber: {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        attemptNumber: input.attemptNumber,
      },
    },
    select: { id: true },
  });
  if (existingSourceAttempt) return { kind: "blocked", reason: "source_attempt_exists" };

  const active = await tx.publicRecoveryDispatch.findFirst({
    where: { igUserId: input.igUserId, state: { in: [...ACTIVE_STATES] } },
    select: { id: true },
  });
  if (active) return { kind: "blocked", reason: "person_reservation_active" };

  const historicalCutoff = new Date(input.now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const prospectiveCutoff = new Date(
    input.now.getTime() - input.prospectiveCooldownHours * 60 * 60 * 1000,
  );
  const recentContact = await tx.publicRecoveryDispatch.findFirst({
    where: {
      igUserId: input.igUserId,
      state: { in: [...TERMINAL_CONTACT_STATES] },
      ...(input.sourceKind === "historical"
        ? { dispatchStartedAt: { gt: historicalCutoff } }
        : {
            OR: [
              { sourceKind: "historical", dispatchStartedAt: { gt: historicalCutoff } },
              { sourceKind: "prospective", dispatchStartedAt: { gt: prospectiveCutoff } },
            ],
          }),
    },
    select: { id: true },
  });
  if (recentContact) return { kind: "blocked", reason: "person_cooldown" };

  const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1000);
  const globalCount = await tx.publicRecoveryDispatch.count({
    where: { state: { in: [...CAPACITY_STATES] }, reservedAt: { gt: hourAgo } },
  });
  if (globalCount >= input.globalHourlyCap) {
    return { kind: "blocked", reason: "global_hourly_cap_reached" };
  }

  if (input.campaignId) {
    const dayAgo = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
    const [campaignHour, campaignDay] = await Promise.all([
      tx.publicRecoveryDispatch.count({
        where: {
          campaignId: input.campaignId,
          state: { in: [...CAPACITY_STATES] },
          reservedAt: { gt: hourAgo },
        },
      }),
      tx.publicRecoveryDispatch.count({
        where: {
          campaignId: input.campaignId,
          state: { in: [...CAPACITY_STATES] },
          reservedAt: { gt: dayAgo },
        },
      }),
    ]);
    if (campaignDay >= (input.campaignDailyCap ?? Number.MAX_SAFE_INTEGER)) {
      return { kind: "blocked", reason: "daily_cap_reached" };
    }
    if (campaignHour >= (input.campaignHourlyCap ?? Number.MAX_SAFE_INTEGER)) {
      return { kind: "blocked", reason: "hourly_cap_reached" };
    }
  }

  const dispatchId = randomUUID();
  const reservationToken = randomUUID();
  await tx.publicRecoveryDispatch.create({
    data: {
      id: dispatchId,
      reservationToken,
      igUserId: input.igUserId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      attemptNumber: input.attemptNumber,
      campaignId: input.campaignId,
      state: "reserved",
      reservedAt: input.now,
      leaseExpiresAt: input.leaseExpiresAt,
    },
  });
  return { kind: "reserved", dispatchId, reservationToken };
}

export async function startPublicRecoveryDispatch(
  tx: Prisma.TransactionClient,
  input: { dispatchId: string; reservationToken: string; now: Date },
): Promise<boolean> {
  const result = await tx.publicRecoveryDispatch.updateMany({
    where: {
      id: input.dispatchId,
      reservationToken: input.reservationToken,
      state: "reserved",
      leaseExpiresAt: { gt: input.now },
    },
    data: { state: "dispatch_started", dispatchStartedAt: input.now },
  });
  return result.count === 1;
}

export async function finalizePublicRecoveryDispatch(
  tx: Prisma.TransactionClient,
  input:
    | {
        kind: "sent";
        dispatchId: string;
        reservationToken: string;
        at: Date;
        providerReplyId: string;
      }
    | {
        kind: "uncertain";
        dispatchId: string;
        reservationToken: string;
        reason: string;
      }
    | {
        kind: "released";
        dispatchId: string;
        reservationToken: string;
        at: Date;
        reason: string;
      },
): Promise<boolean> {
  if (input.kind === "sent" && !input.providerReplyId.trim()) return false;
  if (input.kind !== "sent" && !input.reason.trim()) return false;

  const result = await tx.publicRecoveryDispatch.updateMany({
    where: {
      id: input.dispatchId,
      reservationToken: input.reservationToken,
      state:
        input.kind === "released"
          ? { in: ["reserved", "dispatch_started"] }
          : "dispatch_started",
    },
    data:
      input.kind === "sent"
        ? {
            state: "sent",
            sentAt: input.at,
            providerReplyId: input.providerReplyId,
          }
        : input.kind === "uncertain"
          ? { state: "uncertain", terminalReason: input.reason }
          : {
              state: "released",
              releasedAt: input.at,
              terminalReason: input.reason,
            },
  });
  return result.count === 1;
}

/** Release only rows proven pre-network; started rows become terminal uncertainty. */
export async function reconcileExpiredPublicRecoveryDispatches(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<{ released: number; uncertain: number }> {
  const released = await tx.publicRecoveryDispatch.updateMany({
    where: { state: "reserved", leaseExpiresAt: { lte: now } },
    data: { state: "released", releasedAt: now, terminalReason: "dispatch_lease_expired" },
  });
  const uncertain = await tx.publicRecoveryDispatch.updateMany({
    where: { state: "dispatch_started", leaseExpiresAt: { lte: now } },
    data: { state: "uncertain", terminalReason: "dispatch_lease_expired" },
  });
  return { released: released.count, uncertain: uncertain.count };
}
