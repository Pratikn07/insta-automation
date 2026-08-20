import { env } from "../config/env.js";
import { flags } from "./flagService.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import {
  listDueRecoveryIds,
  claimRecovery,
  authorizeClaimForSend,
  startProspectiveDispatch,
  finalizeProspectiveDispatch,
  reconcileExpiredProspectiveLeases,
  releaseOrSuppressClaim,
} from "./dmRecoveryRepository.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import { replyToComment } from "../meta/replyToComment.js";
import { classifyPublicReplyFailure } from "./graphErrorClassifier.js";

export type DmRecoveryTickResult = {
  examined: number;
  sent: number;
  suppressed: number;
  /** Released, held, or not yet due — deliberately not counted as suppressed. */
  deferred: number;
  failed: number;
  uncertain: number;
  skipped?: "disabled" | "already_running" | "circuit_open" | "hourly_cap" | "daily_cap";
};

let running = false;

/** A send later than this after eligibility is reported as late. */
const LATE_SEND_ALLOWANCE_MS = 60_000;

/** Safe identifiers only — never the public text or a provider body. */
function recoveryEventFields(
  claimed: { id: string; igUserId: string; conversationId: string; keywordId: string; triggerKind: string; cohort: string },
  attempt: number,
): Record<string, unknown> {
  return {
    id: claimed.id,
    conversationId: claimed.conversationId,
    igUserId: claimed.igUserId,
    keywordId: claimed.keywordId,
    triggerKind: claimed.triggerKind,
    cohort: claimed.cohort,
    attempt,
  };
}

function emptyResult(skipped: DmRecoveryTickResult["skipped"]): DmRecoveryTickResult {
  return { examined: 0, sent: 0, suppressed: 0, deferred: 0, failed: 0, uncertain: 0, skipped };
}

export async function runDmRecoveryTick(): Promise<DmRecoveryTickResult> {
  if (!flags.bool("DM_RECOVERY_ENABLED")) return emptyResult("disabled");
  if (running) return emptyResult("already_running");
  running = true;
  try {
    return await runTickBody();
  } catch (error) {
    // Stable code only — a raw error can carry a provider body, a query, or a
    // connection string.
    logger.error(
      { errorCode: "dm_recovery_tick_error", ...describeGraphError(error) },
      "DM recovery tick failed",
    );
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
    deferred: 0,
    failed: 0,
    uncertain: 0,
  };

  // 1. Reconcile expired sending leases → send_uncertain
  await reconcileExpiredProspectiveLeases(now);

  // 2. Evaluate health. The module gathers its own observations: the worker
  // used to hand it hardcoded zeros for the sample inputs, which made the
  // webhook-gap, failure-rate and database-failure trips unreachable.
  const health = await evaluateRecoveryHealth(now);
  if (health.circuitOpen) {
    return emptyResult("circuit_open");
  }

  // 3. List due IDs
  const batchSize = env.DM_RECOVERY_BATCH_SIZE;
  const ids = await listDueRecoveryIds(now, batchSize);

  // 4. Process sequentially
  const leaseMs = env.DM_RECOVERY_LEASE_MS;
  for (const id of ids) {
    // listDueRecoveryIds deliberately returns more than one batch, so a row
    // suppressed during the claim does not consume a send slot. The cap has to
    // be applied here or that headroom becomes extra public comments — a
    // configured batch of 5 would post up to 15.
    if (result.sent >= batchSize) break;
    result.examined++;
    const claimAt = new Date();
    const leaseUntil = new Date(claimAt.getTime() + leaseMs);

    const claimed = await claimRecovery(id, claimAt, leaseUntil);
    if (!claimed) continue;

    // Capacity is rolling from the real reservation instant, not tick start. A batch
    // can spend minutes in provider calls; backdating later reservations makes them
    // expire from the 24-hour window too early.
    const reservationAt = new Date();
    const decision = await authorizeClaimForSend(id, claimed.claimToken, reservationAt);

    // Only an explicit send decision may reach Meta. Written as a positive
    // check so any decision kind added later defaults to NOT posting a public
    // comment — the previous shape made sending the fall-through, so a released
    // stale claim was posted.
    if (
      decision.kind !== "send_no_confirmed_read_reminder" &&
      decision.kind !== "send_settings_fallback"
    ) {
      await releaseOrSuppressClaim(id, decision, reservationAt, claimed.claimToken);
      if (decision.kind === "pause") {
        result.skipped = decision.reason;
        break; // Stop the batch: the circuit or the hourly cap closed.
      }
      if (decision.kind === "suppress") {
        // Only a real suppression counts; a release or a hold is a deferral,
        // not a decision about this person.
        result.suppressed++;
        await logEvent("dm_recovery_suppressed", {
          ...recoveryEventFields(claimed, claimed.attempts),
          reason: decision.reason,
        });
      } else {
        result.deferred++;
      }
      continue;
    }

    // authorizeClaimForSend durably reserved this attempt after claimRecovery
    // had already read the row, so the claimed copy is one behind. Using the
    // stale value granted an extra public send and halved the first backoff.
    const attemptNumber = claimed.attempts + 1;

    const dispatchStarted = await startProspectiveDispatch({
      reminderId: id,
      claimToken: claimed.claimToken,
      dispatchId: decision.dispatchId,
      reservationToken: decision.reservationToken,
      now: new Date(),
    });
    if (!dispatchStarted) {
      await finalizeProspectiveDispatch({
        reminderId: id,
        claimToken: claimed.claimToken,
        dispatchId: decision.dispatchId,
        reservationToken: decision.reservationToken,
        outcome: {
          kind: "released",
          at: new Date(),
          reason: "dispatch_start_rejected",
          sourceStatus: "waiting",
        },
      });
      result.deferred++;
      continue;
    }

    let reply: { replyId: string | null } | null = null;
    let sendError: unknown = null;
    try {
      reply = await replyToComment(claimed.commentId, claimed.publicReplyText);
    } catch (error) {
      sendError = error;
    }

    if (sendError) {
      const meta = describeGraphError(sendError);
      const category = classifyPublicReplyFailure(meta);

      if (category === "open_circuit") {
        await finalizeProspectiveDispatch({
          reminderId: id,
          claimToken: claimed.claimToken,
          dispatchId: decision.dispatchId,
          reservationToken: decision.reservationToken,
          outcome: {
            kind: "released",
            at: new Date(),
            reason: "auth_or_permission",
            sourceStatus: "waiting",
            nextAttemptAt: new Date(now.getTime() + env.DM_RECOVERY_RETRY_BASE_MS),
          },
        });
        await openRecoveryCircuit("auth_or_permission", now);
        result.failed++;
        break; // Credentials will not fix themselves within this batch.
      }

      if (category === "safe_retry") {
        let committed: boolean;
        if (attemptNumber >= env.DM_RECOVERY_MAX_ATTEMPTS) {
          committed = await finalizeProspectiveDispatch({
            reminderId: id,
            claimToken: claimed.claimToken,
            dispatchId: decision.dispatchId,
            reservationToken: decision.reservationToken,
            outcome: {
              kind: "released",
              at: new Date(),
              reason: "rate_limit_exhausted",
              sourceStatus: "send_failed",
            },
          });
        } else {
          const backoffMs =
            env.DM_RECOVERY_RETRY_BASE_MS *
            Math.pow(2, attemptNumber - 1) *
            (0.8 + Math.random() * 0.4);
          committed = await finalizeProspectiveDispatch({
            reminderId: id,
            claimToken: claimed.claimToken,
            dispatchId: decision.dispatchId,
            reservationToken: decision.reservationToken,
            outcome: {
              kind: "released",
              at: new Date(),
              reason: "rate_limit",
              sourceStatus: "waiting",
              nextAttemptAt: new Date(now.getTime() + backoffMs),
            },
          });
        }
        if (committed) result.failed++;
        else await logEvent("dm_recovery_finalize_failed", {
          ...recoveryEventFields(claimed, attemptNumber),
          stage: "rate_limit",
        });
        continue;
      }

      if (category === "permanent") {
        const errCat = meta.graphCode ? `code_${meta.graphCode}` : "permanent";
        if (!(await finalizeProspectiveDispatch({
          reminderId: id,
          claimToken: claimed.claimToken,
          dispatchId: decision.dispatchId,
          reservationToken: decision.reservationToken,
          outcome: {
            kind: "released",
            at: new Date(),
            reason: errCat,
            sourceStatus: "send_failed",
          },
        }))) {
          await logEvent("dm_recovery_finalize_failed", {
            ...recoveryEventFields(claimed, attemptNumber),
            stage: "permanent",
          });
          continue;
        }
        result.failed++;
        await logEvent("dm_recovery_send_failed", {
          ...recoveryEventFields(claimed, attemptNumber),
          category: errCat,
        });
        continue;
      }

      // Timeout, reset, or anything unrecognised: the send may have landed, so
      // it is never retried automatically.
      const errCat = meta.category ?? "unknown";
      if (!(await finalizeProspectiveDispatch({
        reminderId: id,
        claimToken: claimed.claimToken,
        dispatchId: decision.dispatchId,
        reservationToken: decision.reservationToken,
        outcome: { kind: "uncertain", reason: errCat },
      }))) {
        await logEvent("dm_recovery_finalize_failed", {
          ...recoveryEventFields(claimed, attemptNumber),
          stage: "uncertain",
        });
        continue;
      }
      result.uncertain++;
      await logEvent("dm_recovery_send_uncertain", {
        ...recoveryEventFields(claimed, attemptNumber),
        category: errCat,
      });
      continue;
    }

    // Meta has answered. Everything below is bookkeeping and must never cause
    // another send — a failure here is a reconciliation problem, not a send
    // outcome, and misclassifying it through the Graph classifier would be
    // accidental rather than deliberate safety.
    try {
      if (reply!.replyId) {
        const sentAt = new Date();
        const persisted = await finalizeProspectiveDispatch({
          reminderId: id,
          claimToken: claimed.claimToken,
          dispatchId: decision.dispatchId,
          reservationToken: decision.reservationToken,
          outcome: { kind: "sent", at: sentAt, providerReplyId: reply!.replyId },
        });
        if (!persisted) {
          // Meta posted but the row did not move. Reporting a send here would
          // put the metrics and the table permanently out of step; the lease
          // reconciles the row to send_uncertain instead.
          await logEvent("dm_recovery_finalize_failed", {
            ...recoveryEventFields(claimed, attemptNumber),
            stage: "mark_sent",
          });
          continue;
        }
        result.sent++;
        await logEvent("dm_recovery_sent", {
          ...recoveryEventFields(claimed, attemptNumber),
          latenessMs: sentAt.getTime() - claimed.eligibleAt.getTime(),
        });
        // A reminder posted long after it became eligible is not the
        // intervention the experiment measures, so the lag must be visible.
        if (sentAt.getTime() - claimed.eligibleAt.getTime() > LATE_SEND_ALLOWANCE_MS) {
          await logEvent("dm_recovery_sent_late", {
            ...recoveryEventFields(claimed, attemptNumber),
            latenessMs: sentAt.getTime() - claimed.eligibleAt.getTime(),
          });
        }
      } else {
        if (!(await finalizeProspectiveDispatch({
          reminderId: id,
          claimToken: claimed.claimToken,
          dispatchId: decision.dispatchId,
          reservationToken: decision.reservationToken,
          outcome: { kind: "uncertain", reason: "success_without_id" },
        }))) {
          await logEvent("dm_recovery_finalize_failed", {
            ...recoveryEventFields(claimed, attemptNumber),
            stage: "success_without_id",
          });
          continue;
        }
        result.uncertain++;
        await logEvent("dm_recovery_send_uncertain", {
          ...recoveryEventFields(claimed, attemptNumber),
          category: "success_without_id",
        });
      }
    } catch {
      // The lease reconciles this row to send_uncertain on a later tick.
      await logEvent("dm_recovery_finalize_failed", {
        ...recoveryEventFields(claimed, attemptNumber),
      });
    }
  }

  return result;
}
