import type { DmRecoveryReminder, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { logEvent } from "./eventLogger.js";
import {
  decideRecovery,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "./dmRecoveryPolicy.js";

export type ClaimedRecovery = DmRecoveryReminder;

export type FinalRecoveryCheck =
  | RecoveryDecision
  | { kind: "pause"; reason: "circuit_open" | "hourly_cap" }
  /** Hand the row back to `waiting` without judging the person. */
  | { kind: "release"; reason: string };

const COOLDOWN_HOURS_FALLBACK = 24;

type PolicyContext = {
  now: Date;
  conversationCompletedAt: Date | null;
  hasRecentSentReminderForPerson: boolean;
  hasNewerEligibleCandidate: boolean;
};

/**
 * Gather everything decideRecovery needs that does not live on the row.
 *
 * Every read happens inside the caller's transaction, so the decision is made
 * against one consistent snapshot rather than values that could drift between
 * checks.
 */
async function loadPolicyContext(
  tx: Prisma.TransactionClient,
  row: DmRecoveryReminder,
  now: Date,
): Promise<PolicyContext> {
  const convo = await tx.conversation.findUnique({
    where: { id: row.conversationId },
    select: { state: true, completedAt: true },
  });

  const cooldownHours = env.DM_RECOVERY_COOLDOWN_HOURS ?? COOLDOWN_HOURS_FALLBACK;
  const cooldownSince = new Date(now.getTime() - cooldownHours * 60 * 60 * 1000);

  // A confirmed send starts the cooldown, and so does an outcome-uncertain
  // attempt: we cannot prove that one did not reach the person.
  const recentAttempt = await tx.dmRecoveryReminder.findFirst({
    where: {
      igUserId: row.igUserId,
      id: { not: row.id },
      OR: [
        { sentAt: { gte: cooldownSince } },
        {
          lastAttemptAt: { gte: cooldownSince },
          status: { in: ["sending", "send_uncertain"] },
        },
      ],
    },
    select: { id: true },
  });

  // "The most recently eligible record wins." Due rows are processed oldest
  // first for fairness across people, so without this the OLDEST reminder would
  // win for any one person. Ordering matches the plan: highest eligibleAt, then
  // newest createdAt, then a stable id tie-break.
  const newerCandidate = await tx.dmRecoveryReminder.findFirst({
    where: {
      igUserId: row.igUserId,
      id: { not: row.id },
      status: "waiting",
      eligibleAt: { lte: now },
      OR: [
        { eligibleAt: { gt: row.eligibleAt } },
        { eligibleAt: row.eligibleAt, createdAt: { gt: row.createdAt } },
        { eligibleAt: row.eligibleAt, createdAt: row.createdAt, id: { gt: row.id } },
      ],
    },
    select: { id: true },
  });

  return {
    now,
    conversationCompletedAt:
      convo?.state === "completed" ? (convo.completedAt ?? now) : null,
    hasRecentSentReminderForPerson: Boolean(recentAttempt),
    hasNewerEligibleCandidate: Boolean(newerCandidate),
  };
}

function toPolicyInput(
  row: DmRecoveryReminder,
  ctx: PolicyContext,
  statusOverride?: string,
): RecoveryPolicyInput {
  return {
    now: ctx.now,
    triggerKind: row.triggerKind,
    status: statusOverride ?? row.status,
    cohort: row.cohort,
    eligibleAt: row.eligibleAt,
    acceptedAt: row.acceptedAt,
    instagramGateMessageId: row.instagramGateMessageId,
    commentId: row.commentId,
    seenAt: row.seenAt,
    engagedAt: row.engagedAt,
    firstEngagementKind: row.firstEngagementKind,
    conversationCompletedAt: ctx.conversationCompletedAt,
    // Cross-journey completion is already resolved by the completion
    // transaction, so anything still live here completed on its own journey.
    conversationCompletedElsewhere: false,
    cancelledAt: row.cancelledAt,
    hasRecentSentReminderForPerson: ctx.hasRecentSentReminderForPerson,
    hasNewerEligibleCandidate: ctx.hasNewerEligibleCandidate,
    isSourceCommentAvailable: Boolean(row.commentId),
  };
}

function isSendDecision(decision: RecoveryDecision): boolean {
  return (
    decision.kind === "send_no_confirmed_read_reminder" ||
    decision.kind === "send_settings_fallback"
  );
}

/** Persist a terminal or withholding policy result. `wait` needs no write. */
async function persistNonSendDecision(
  tx: Prisma.TransactionClient,
  id: string,
  decision: RecoveryDecision,
  now: Date,
): Promise<void> {
  if (decision.kind === "suppress") {
    await tx.dmRecoveryReminder.update({
      where: { id },
      data: {
        status: "suppressed",
        suppressedAt: now,
        suppressionReason: decision.reason,
      },
    });
    return;
  }
  if (decision.kind === "holdout") {
    // Reconcile a row whose cohort says control but whose status did not.
    await tx.dmRecoveryReminder.update({ where: { id }, data: { status: "control" } });
  }
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

          const ctx = await loadPolicyContext(tx, candidate, now);
          const decision = decideRecovery(toPolicyInput(candidate, ctx));

          if (!isSendDecision(decision)) {
            await persistNonSendDecision(tx, id, decision, now);
            if (decision.kind === "suppress") {
              await logEvent("dm_recovery_cooldown_suppressed", {
                id,
                igUserId: candidate.igUserId,
                reason: decision.reason,
              });
            }
            return null;
          }

          await logEvent("dm_recovery_ready", {
            id,
            igUserId: candidate.igUserId,
            triggerKind: candidate.triggerKind,
          });

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
      // Circuit state and hourly capacity are process-wide. Locking the
      // singleton serialises those reads across workers, so two processes
      // cannot both observe spare capacity and both send.
      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;

      const control = await tx.dmRecoveryControl.findUnique({ where: { id: 1 } });
      if (control?.circuitOpen) {
        return { kind: "pause", reason: "circuit_open" };
      }

      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const hourlyCount = await tx.dmRecoveryReminder.count({
        where: {
          OR: [
            { sentAt: { gte: oneHourAgo } },
            { lastAttemptAt: { gte: oneHourAgo }, status: "sending" },
          ],
        },
      });
      if (hourlyCount >= (env.DM_RECOVERY_HOURLY_CAP ?? 30)) {
        return { kind: "pause", reason: "hourly_cap" };
      }

      const row = await tx.dmRecoveryReminder.findUnique({ where: { id } });
      if (!row || row.status !== "sending" || !row.claimExpiresAt || row.claimExpiresAt <= now) {
        return { kind: "release", reason: "stale_claim" };
      }

      // Evidence, a cooldown, or a newer candidate can all arrive during the
      // lease window, so the full policy runs again here — the last moment
      // before a public comment is posted. The row is `sending` because we hold
      // the claim; the policy is asked whether that claim may still proceed.
      const ctx = await loadPolicyContext(tx, row, now);
      const decision = decideRecovery(toPolicyInput(row, ctx, "waiting"));

      if (!isSendDecision(decision)) {
        await persistNonSendDecision(tx, id, decision, now);
        return decision;
      }

      // Durable reservation: stamping the attempt inside this transaction is
      // what stops another process overrunning the hourly cap.
      await tx.dmRecoveryReminder.update({
        where: { id },
        data: { lastAttemptAt: now, attempts: row.attempts + 1 },
      });

      return decision;
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
  // Without an id from Meta the send is unconfirmed. Recording it as `sent`
  // would claim delivery we cannot prove and start the person's 24h cooldown.
  if (!input.replyId?.trim()) return false;

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
  decision: FinalRecoveryCheck,
  now: Date,
): Promise<boolean> {
  // Every non-send outcome must move the row out of `sending`. A row left
  // claimed is reconciled to send_uncertain once its lease expires, which sends
  // a perfectly healthy hold to manual review.
  const data =
    decision.kind === "suppress"
      ? {
          status: "suppressed" as const,
          suppressionReason: decision.reason,
          suppressedAt: now,
          claimedAt: null,
          claimExpiresAt: null,
        }
      : decision.kind === "holdout"
        ? { status: "control" as const, claimedAt: null, claimExpiresAt: null }
        : // pause, release and wait all hand the row back untouched: the person
          // has not been judged, only deferred.
          { status: "waiting" as const, claimedAt: null, claimExpiresAt: null };

  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: { id, status: "sending" },
      data,
    });
    return res.count > 0;
  } catch {
    return false;
  }
}
