import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import {
  listDueRecoveryIds,
  claimRecovery,
  authorizeClaimForSend,
  markRecoverySent,
  markRecoveryRetryable,
  markRecoveryFailed,
  markRecoveryUncertain,
  releaseOrSuppressClaim,
} from "./dmRecoveryRepository.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import type { HealthInput } from "./dmRecoveryHealth.js";
import { replyToComment } from "../meta/replyToComment.js";
import { classifyPublicReplyFailure } from "./graphErrorClassifier.js";

export type DmRecoveryTickResult = {
  examined: number;
  sent: number;
  suppressed: number;
  failed: number;
  uncertain: number;
  skipped?: "disabled" | "already_running" | "circuit_open" | "hourly_cap";
};

let running = false;

function emptyResult(skipped: DmRecoveryTickResult["skipped"]): DmRecoveryTickResult {
  return { examined: 0, sent: 0, suppressed: 0, failed: 0, uncertain: 0, skipped };
}

export async function runDmRecoveryTick(): Promise<DmRecoveryTickResult> {
  if (!env.DM_RECOVERY_ENABLED) return emptyResult("disabled");
  if (running) return emptyResult("already_running");
  running = true;
  try {
    return await runTickBody();
  } catch (error) {
    logger.error({ errorCode: "dm_recovery_tick_error", error }, "DM recovery tick failed");
    return emptyResult(undefined);
  } finally {
    running = false;
  }
}

async function runTickBody(): Promise<DmRecoveryTickResult> {
  const now = new Date();
  const result: DmRecoveryTickResult = {
    examined: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    uncertain: 0,
  };

  // 1. Reconcile expired sending leases → send_uncertain
  await prisma.dmRecoveryReminder.updateMany({
    where: { status: "sending", claimExpiresAt: { lte: now } },
    data: {
      status: "send_uncertain",
      lastErrorCategory: "stale_lease",
      claimedAt: null,
      claimExpiresAt: null,
    },
  });

  // 2. Evaluate health
  const healthInput: HealthInput = {
    now,
    dueCount: await prisma.dmRecoveryReminder.count({
      where: { status: "waiting", eligibleAt: { lte: now } },
    }),
    sentLastHour: await prisma.dmRecoveryReminder.count({
      where: { sentAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
    }),
    outcomeCount: 0,
    publicFailureCount: 0,
    acceptedCount: 0,
    seenOrEngagedCount: 0,
    recentDatabaseFailures: 0,
  };
  const health = await evaluateRecoveryHealth(healthInput);
  if (health.circuitOpen) {
    return emptyResult("circuit_open");
  }

  // 3. List due IDs
  const batchSize = env.DM_RECOVERY_BATCH_SIZE;
  const ids = await listDueRecoveryIds(now, batchSize);

  // 4. Process sequentially
  const leaseMs = env.DM_RECOVERY_LEASE_MS;
  for (const id of ids) {
    result.examined++;
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const claimed = await claimRecovery(id, now, leaseUntil);
    if (!claimed) continue;

    const decision = await authorizeClaimForSend(id, now);

    if (decision.kind === "pause") {
      await releaseOrSuppressClaim(id, decision, now);
      result.skipped = decision.reason as "circuit_open" | "hourly_cap";
      break; // Stop batch on pause
    }

    if (
      decision.kind === "suppress" ||
      decision.kind === "holdout" ||
      decision.kind === "wait"
    ) {
      await releaseOrSuppressClaim(id, decision, now);
      result.suppressed++;
      continue;
    }

    // decision.kind is send_no_confirmed_read_reminder or send_settings_fallback
    try {
      const reply = await replyToComment(claimed.commentId, claimed.publicReplyText);

      if (reply.replyId) {
        await markRecoverySent(id, { replyId: reply.replyId, sentAt: new Date() });
        result.sent++;
        await logEvent("dm_recovery_sent", {
          id,
          igUserId: claimed.igUserId,
          triggerKind: claimed.triggerKind,
          cohort: claimed.cohort,
          attempts: claimed.attempts,
        });
      } else {
        await markRecoveryUncertain(id, { category: "success_without_id" });
        result.uncertain++;
        await logEvent("dm_recovery_send_uncertain", {
          id,
          igUserId: claimed.igUserId,
          category: "success_without_id",
        });
      }
    } catch (error) {
      const meta = describeGraphError(error);
      const category = classifyPublicReplyFailure(meta);

      if (category === "open_circuit") {
        await markRecoveryRetryable(id, {
          category: "auth_or_permission",
          nextAttemptAt: new Date(now.getTime() + env.DM_RECOVERY_RETRY_BASE_MS),
        });
        await openRecoveryCircuit("auth_or_permission", now);
        result.failed++;
        break; // Stop batch on auth failure
      }

      if (category === "safe_retry") {
        const backoffMs =
          env.DM_RECOVERY_RETRY_BASE_MS *
          Math.pow(2, claimed.attempts - 1) *
          (0.8 + Math.random() * 0.4);
        const nextAttemptAt = new Date(now.getTime() + backoffMs);

        if (claimed.attempts >= env.DM_RECOVERY_MAX_ATTEMPTS) {
          await markRecoveryFailed(id, { category: "rate_limit_exhausted" });
          result.failed++;
        } else {
          await markRecoveryRetryable(id, { category: "rate_limit", nextAttemptAt });
          result.failed++;
        }
        continue;
      }

      if (category === "permanent") {
        const errCat = meta.graphCode ? `code_${meta.graphCode}` : "permanent";
        await markRecoveryFailed(id, { category: errCat });
        result.failed++;
        await logEvent("dm_recovery_send_failed", {
          id,
          igUserId: claimed.igUserId,
          category: errCat,
        });
        continue;
      }

      // Timeout, connection_reset, unknown → uncertain (no auto retry)
      const errCat = meta.category ?? "unknown";
      await markRecoveryUncertain(id, { category: errCat });
      result.uncertain++;
      await logEvent("dm_recovery_send_uncertain", {
        id,
        igUserId: claimed.igUserId,
        category: errCat,
      });
    }
  }

  return result;
}
