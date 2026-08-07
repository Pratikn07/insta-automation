import type { DmRecoveryReminder, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { logEvent } from "./eventLogger.js";
import { decideRecovery, type RecoveryDecision } from "./dmRecoveryPolicy.js";

export type ClaimedRecovery = DmRecoveryReminder;

export type FinalRecoveryCheck =
  | RecoveryDecision
  | { kind: "pause"; reason: "circuit_open" | "hourly_cap" }
  | { kind: "holdout"; reason: string; nextCheckAt: Date | null };

function evidenceToSuppression(row: DmRecoveryReminder): import("./dmRecoveryPolicy.js").RecoverySuppressionReason {
  if (row.seenAt) return "seen";
  if (row.repliedAt) return "inbound_reply";
  if (row.reactedAt) return "reaction";
  if (row.postbackAt) return "postback";
  if (row.cancelledAt) return "owner_cancelled";
  return "seen";
}

const P2034_RETRY_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * List due recovery reminder IDs ordered by eligibleAt ASC, createdAt ASC.
 */
export async function listDueRecoveryIds(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.dmRecoveryReminder.findMany({
    where: {
      status: "waiting",
      eligibleAt: { lte: now },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true },
    orderBy: [{ eligibleAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  return rows.map((r) => r.id);
}

/**
 * Claim an eligible waiting recovery row compare-and-set style.
 * Uses a row lock on ig_users in a transaction with retries for serialization conflicts (P2034).
 */
export async function claimRecovery(
  id: string,
  now: Date,
  leaseUntil: Date,
): Promise<ClaimedRecovery | null> {
  let attempt = 0;
  while (attempt < P2034_RETRY_ATTEMPTS) {
    attempt++;
    try {
      return await prisma.$transaction(
        async (tx) => {
          const candidate = await tx.dmRecoveryReminder.findUnique({
            where: { id },
          });

          if (
            !candidate ||
            candidate.status !== "waiting" ||
            candidate.eligibleAt > now ||
            (candidate.nextAttemptAt !== null && candidate.nextAttemptAt > now)
          ) {
            return null;
          }

          // Row lock person to serialize decisions for this user
          try {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "ig_users" WHERE "id" = ${candidate.igUserId} FOR UPDATE
            `;
          } catch {
            // ig_user row lock attempt ignored if user deleted
          }

          // Recheck state & policy for person
          const convo = await tx.conversation.findUnique({
            where: { id: candidate.conversationId },
            select: { state: true },
          });

          if (convo?.state === "completed") {
            await tx.dmRecoveryReminder.update({
              where: { id },
              data: {
                status: "suppressed",
                suppressedAt: now,
                suppressionReason: "completed",
              },
            });
            return null;
          }

          // Check person 24h rolling cooldown (sentAt or recent lastAttemptAt for sending/send_uncertain)
          const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const recentSend = await tx.dmRecoveryReminder.findFirst({
            where: {
              igUserId: candidate.igUserId,
              id: { not: candidate.id },
              OR: [
                { sentAt: { gte: twentyFourHoursAgo } },
                {
                  lastAttemptAt: { gte: twentyFourHoursAgo },
                  status: { in: ["sending", "send_uncertain"] },
                },
              ],
            },
            select: { id: true },
          });

          if (recentSend) {
            await tx.dmRecoveryReminder.update({
              where: { id },
              data: {
                status: "suppressed",
                suppressedAt: now,
                suppressionReason: "person_cooldown",
              },
            });
            await logEvent("dm_recovery_cooldown_suppressed", {
              id,
              igUserId: candidate.igUserId,
              reason: "person_cooldown",
            });
            return null;
          }

          // Perform atomic compare-and-set claim
          const result = await tx.dmRecoveryReminder.updateMany({
            where: {
              id,
              status: "waiting",
              eligibleAt: { lte: now },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            data: {
              status: "sending",
              claimedAt: now,
              claimExpiresAt: leaseUntil,
            },
          });

          if (result.count === 0) return null;

          const claimedRow = await tx.dmRecoveryReminder.findUnique({
            where: { id },
          });

          if (claimedRow) {
            await logEvent("dm_recovery_claimed", {
              id,
              igUserId: claimedRow.igUserId,
              status: "sending",
            });
          }

          return claimedRow;
        },
        { isolationLevel: "Serializable" },
      );
    } catch (err: any) {
      if (err?.code === "P2034" && attempt < P2034_RETRY_ATTEMPTS) {
        await sleep(20 + Math.random() * 30);
        continue;
      }
      logger.error({ errorCode: "claim_recovery_failed", id, err }, "claimRecovery error");
      return null;
    }
  }
  return null;
}

/**
 * Final pre-network authorization check before worker calls Meta.
 * Locks the singleton dm_recovery_control row and checks circuit state, hourly cap, evidence, and cooldown.
 */
export async function authorizeClaimForSend(
  id: string,
  now: Date,
): Promise<FinalRecoveryCheck> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock singleton control row
      const control = await tx.dmRecoveryControl.findUnique({ where: { id: 1 } });
      if (control?.circuitOpen) {
        return { kind: "pause", reason: "circuit_open" };
      }

      // Check hourly capacity
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const hourlyCount = await tx.dmRecoveryReminder.count({
        where: {
          OR: [
            { sentAt: { gte: oneHourAgo } },
            { lastAttemptAt: { gte: oneHourAgo }, status: "sending" },
          ],
        },
      });

      const maxHourlyCap = env.DM_RECOVERY_HOURLY_CAP ?? 30;
      if (hourlyCount >= maxHourlyCap) {
        return { kind: "pause", reason: "hourly_cap" };
      }

      // Load row to recheck predicates
      const row = await tx.dmRecoveryReminder.findUnique({ where: { id } });
      if (!row || row.status !== "sending" || !row.claimExpiresAt || row.claimExpiresAt <= now) {
        return { kind: "holdout", reason: "stale_claim", nextCheckAt: null };
      }

      if (
        row.seenAt ||
        row.engagedAt ||
        row.repliedAt ||
        row.reactedAt ||
        row.postbackAt ||
        row.cancelledAt
      ) {
        const reason = evidenceToSuppression(row);
        await tx.dmRecoveryReminder.update({
          where: { id },
          data: {
            status: "suppressed",
            suppressedAt: now,
            suppressionReason: reason,
            claimedAt: null,
            claimExpiresAt: null,
          },
        });
        return { kind: "suppress", reason };
      }

      const convo = await tx.conversation.findUnique({
        where: { id: row.conversationId },
        select: { state: true },
      });

      if (convo?.state === "completed") {
        await tx.dmRecoveryReminder.update({
          where: { id },
          data: {
            status: "suppressed",
            suppressedAt: now,
            suppressionReason: "completed",
            claimedAt: null,
            claimExpiresAt: null,
          },
        });
        return { kind: "suppress", reason: "completed" };
      }

      // Reserve capacity and record lastAttemptAt timestamp
      await tx.dmRecoveryReminder.update({
        where: { id },
        data: {
          lastAttemptAt: now,
          attempts: row.attempts + 1,
        },
      });

      if (row.triggerKind === "settings_blocked") {
        return { kind: "send_settings_fallback" };
      }

      return { kind: "send_no_confirmed_read_reminder" };
    });
  } catch (err) {
    logger.error({ errorCode: "authorize_claim_failed", id, err }, "authorizeClaimForSend failed");
    return { kind: "pause", reason: "circuit_open" };
  }
}

/**
 * Mark a sending recovery as sent upon Meta confirmation.
 */
export async function markRecoverySent(
  id: string,
  input: { replyId: string; sentAt: Date },
): Promise<boolean> {
  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: { id, status: "sending" },
      data: {
        status: "sent",
        publicReplyId: input.replyId,
        sentAt: input.sentAt,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * Mark a sending recovery as retryable.
 */
export async function markRecoveryRetryable(
  id: string,
  input: { category: string; nextAttemptAt: Date },
): Promise<boolean> {
  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: { id, status: "sending" },
      data: {
        status: "waiting",
        lastErrorCategory: input.category,
        nextAttemptAt: input.nextAttemptAt,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * Mark a sending recovery as failed permanently.
 */
export async function markRecoveryFailed(
  id: string,
  input: { category: string },
): Promise<boolean> {
  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: { id, status: "sending" },
      data: {
        status: "send_failed",
        lastErrorCategory: input.category,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * Mark a sending recovery as send_uncertain.
 */
export async function markRecoveryUncertain(
  id: string,
  input: { category: string },
): Promise<boolean> {
  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: { id, status: "sending" },
      data: {
        status: "send_uncertain",
        lastErrorCategory: input.category,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return res.count > 0;
  } catch {
    return false;
  }
}

/**
 * Release a paused claim back to waiting or suppress a claim.
 */
export async function releaseOrSuppressClaim(
  id: string,
  decision: RecoveryDecision | { kind: "pause"; reason: string },
  now: Date,
): Promise<boolean> {
  try {
    if (decision.kind === "pause") {
      const res = await prisma.dmRecoveryReminder.updateMany({
        where: { id, status: "sending" },
        data: {
          status: "waiting",
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      return res.count > 0;
    } else if (decision.kind === "suppress") {
      const res = await prisma.dmRecoveryReminder.updateMany({
        where: { id, status: "sending" },
        data: {
          status: "suppressed",
          suppressionReason: decision.reason,
          suppressedAt: now,
          claimedAt: null,
          claimExpiresAt: null,
        },
      });
      return res.count > 0;
    }
    return false;
  } catch {
    return false;
  }
}
