import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { sendTrackedPrivateReply, sendTrackedText } from "./dmDeliveryService.js";
import { guideFollowGateV2Selector } from "./guideFollowGateV2Rollout.js";
import { recordGuideAccessMetric } from "./guideAccessMetrics.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { PRIVATE_REPLY_WINDOW_MS } from "./gateQueueService.js";
import {
  classifyPrivateGateFailure,
  parseGraphSignatures,
} from "./graphErrorClassifier.js";
import {
  scheduleAcceptedGateRecovery,
  scheduleSettingsBlockedRecovery,
  scheduleTrackingUnavailableRecovery,
} from "./dmRecoveryService.js";
import {
  resolveActiveSettingsBlockedVerification,
  settingsBlockedVerificationRejectionReason,
} from "./settingsBlockedVerificationService.js";
import { conversationHistoryRole } from "./canonicalConversation.js";

const BASE_BACKOFF_MS = 15 * 60 * 1000; // 15 min
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000; // 2 h
const PER_SEND_GAP_MS = 4000; // gentle spacing between sends within a tick

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reconcile stale sending claims (leases that expired while worker crashed/restarted).
 * These rows are moved to `send_uncertain` and an attention recovery row is created.
 */
async function reconcileStaleSendingClaims(now: Date): Promise<void> {
  const staleRows = await prisma.gateQueue.findMany({
    where: {
      status: "sending",
      claimExpiresAt: { lte: now },
    },
    select: {
      id: true,
      conversationId: true,
      igUserId: true,
      commentId: true,
      mediaId: true,
    },
  });

  for (const row of staleRows) {
    await prisma.gateQueue.update({
      where: { id: row.id },
      data: { status: "send_uncertain", lastError: "private_send_outcome_unknown" },
    });

    const convo = await prisma.conversation.findUnique({
      where: { id: row.conversationId },
      include: { keyword: true },
    });

    if (convo?.keyword) {
      try {
        await scheduleTrackingUnavailableRecovery({
          conversationId: row.conversationId,
          igUserId: row.igUserId,
          keywordId: convo.keywordId,
          keywordSnapshot: convo.keyword.keyword,
          commentId: row.commentId,
          mediaId: row.mediaId,
          observedAt: new Date(),
        });
      } catch {
        await logEvent("dm_recovery_schedule_failed", {
          conversationId: row.conversationId,
          commentId: row.commentId,
          triggerKind: "tracking_unavailable",
        });
      }
    }
  }
}

/**
 * One worker tick: drain a small, paced batch of pending gate retries that are due
 * and still inside the 7-day private-reply window. Adaptive: stops early for this
 * tick the moment the rate limit reappears (no point hammering a closed window),
 * and processes oldest-first so nobody starves.
 *
 * Fully non-throwing — a worker crash must never take down the server.
 */
export async function runGateQueueTick(): Promise<void> {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - PRIVATE_REPLY_WINDOW_MS);

    // Reconcile stale sending leases from interrupted workers.
    await reconcileStaleSendingClaims(now);

    // Mark rows whose 7-day window has closed as exhausted (can't private-reply anymore).
    await prisma.gateQueue.updateMany({
      where: { status: "pending", commentAt: { lt: windowStart } },
      data: { status: "exhausted" },
    });

    // Retire rows already at the attempt ceiling.
    await prisma.gateQueue.updateMany({
      where: { status: "pending", attempts: { gte: env.GATE_MAX_ATTEMPTS } },
      data: { status: "exhausted" },
    });

    const dueCandidates = await prisma.gateQueue.findMany({
      where: {
        status: "pending",
        nextAttemptAt: { lte: now },
        commentAt: { gte: windowStart },
      },
      orderBy: { commentAt: "asc" },
      take: env.GATE_RETRY_BATCH,
    });

    if (dueCandidates.length === 0) {
      await maybeRunExperiment();
      return;
    }

    // Atomic claims: attempt to move each due item from pending -> sending with lease
    const leaseDuration = env.DM_RECOVERY_LEASE_MS ?? 15 * 60 * 1000;
    const claimedRows = [];
    for (const item of dueCandidates) {
      const claimExpiresAt = new Date(now.getTime() + leaseDuration);
      const claimed = await prisma.gateQueue.updateMany({
        where: {
          id: item.id,
          status: "pending",
          // Ticks are not guarded against overlapping, so a row an earlier tick
          // just pushed into backoff is still `pending`. Without this predicate
          // it would be re-claimed and sent immediately, skipping the backoff.
          nextAttemptAt: { lte: now },
        },
        data: {
          status: "sending",
          claimedAt: now,
          claimExpiresAt,
        },
      });
      if (claimed.count > 0) {
        claimedRows.push(item);
      }
    }

    if (claimedRows.length === 0) return;

    let sent = 0;
    let processedCount = 0;
    try {
      // Load conversations and keywords
      const convos = await prisma.conversation.findMany({
        where: { id: { in: claimedRows.map((r) => r.conversationId) } },
        // canonicalIntent carries the authoritative completion. A gate row belonging to
        // a reconciled ALIAS has its own state, and that state can say awaiting_done
        // while the person already received the guide through a sibling journey (QA-05).
        include: {
          keyword: true,
          canonicalIntent: {
            select: { completedAt: true, canonicalConversationId: true },
          },
        },
      });
      const convoMap = new Map(convos.map((c) => [c.id, c]));

      for (const row of claimedRows) {
        processedCount++;
        const convo = convoMap.get(row.conversationId);
        if (!convo || !convo.keyword) {
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "exhausted", lastError: "conversation_or_keyword_missing" },
          });
          continue;
        }

        // Either this conversation completed, OR its canonical intent did. The second
        // case is the alias problem: after reconciliation a superseded conversation can
        // still read awaiting_done while the request it belongs to was satisfied
        // elsewhere, and delivering here would gate someone who has the guide.
        const isAlias = conversationHistoryRole({
          conversationId: convo.id,
          canonicalIntentId: convo.canonicalIntentId,
          canonicalConversationId: convo.canonicalIntent?.canonicalConversationId,
        }) === "alias";
        const intentCompleted = convo.canonicalIntent?.completedAt != null;
        if (isAlias || convo.state === "completed" || intentCompleted) {
          const reason = isAlias
            ? "reconciled_alias"
            : intentCompleted && convo.state !== "completed"
              ? "intent_completed_elsewhere"
              : "conversation_completed";
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "abandoned", lastError: reason },
          });
          await logEvent("gate_abandoned", {
            conversationId: row.conversationId,
            reason,
            attempts: row.attempts,
          });
          continue;
        }

        try {
          const receipt = await sendTrackedPrivateReply({
            recipientIgUserId: row.igUserId,
            commentId: row.commentId,
            text: row.gateMessage,
            source: "keyword_automation",
          });

          // Immediately finalize delivery state
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "sent", attempts: row.attempts + 1, lastError: null },
          });
          await prisma.conversation.update({
            where: { id: row.conversationId },
            data: { state: "awaiting_done", gatedAt: new Date() },
          });
          // A queued row can now belong to the strict gate, because a failed strict
          // opening is queued here. Ownership is computed the same way every other
          // call site computes it, rather than snapshotted, so an allowlist change
          // cannot leave a stale row on the wrong path. Fails closed to V1.
          let retryOwner: "v1" | "v2" = "v1";
          try {
            retryOwner = guideFollowGateV2Selector.owner({
              igUserId: row.igUserId,
              resourceId: convo.keyword.resourceId,
            });
          } catch {
            logger.warn(
              { errorCode: "strict_gate_owner_unavailable", gateQueueId: row.id },
              "Strict gate ownership unavailable — treating retry as V1",
            );
          }

          await logEvent("dm_sent", {
            conversationId: row.conversationId,
            kind: "gate",
            source: "retry",
            // Tagged so V2 retry volume never silently inflates the V1 baseline.
            gateOwner: retryOwner,
          });

          // if/else rather than `continue`: the shared tail below owns the tick
          // counter and the inter-send pacing, and a strict retry must not skip
          // either. Skipping the pacing would fire private replies back to back in a
          // worker that aborts its whole tick on a rate limit.
          if (retryOwner === "v2") {
            // The strict opening was re-sent, so this counts on V2's own metric.
            await recordGuideAccessMetric("opening", "accepted");
          }
          if (retryOwner !== "v2" || flags.bool("DM_RECOVERY_TWO_HOUR_ALL_ENABLED")) {
            // Schedule recovery in separate block (failures do not un-send or revert queue)
            try {
              await scheduleAcceptedGateRecovery({
                conversationId: row.conversationId,
                igUserId: row.igUserId,
                keywordId: convo.keywordId,
                keywordSnapshot: convo.keyword.keyword,
                commentId: row.commentId,
                mediaId: row.mediaId,
                gateDmMessageId: receipt.dmMessageId,
                instagramGateMessageId: receipt.instagramMessageId,
                acceptedAt: receipt.acceptedAt,
              });
            } catch {
              await logEvent("dm_recovery_schedule_failed", {
                conversationId: row.conversationId,
                commentId: row.commentId,
                triggerKind: "no_confirmed_read",
              });
            }
          }

          sent++;
          await sleep(PER_SEND_GAP_MS);
        } catch (err) {
          const metadata = describeGraphError(err);
          const classification = classifyPrivateGateFailure(
            metadata,
            parseGraphSignatures(env.DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES),
          );
          const attempts = row.attempts + 1;

          if (classification === "settings_blocked") {
            await prisma.gateQueue.update({
              where: { id: row.id },
              data: { status: "abandoned", attempts, lastError: "settings_blocked" },
            });
            let verification;
            try {
              verification = await resolveActiveSettingsBlockedVerification(metadata);
            } catch (verificationError) {
              await logEvent("dm_recovery_verification_rejected", {
                conversationId: row.conversationId,
                commentId: row.commentId,
                triggerKind: "settings_blocked",
                reason: settingsBlockedVerificationRejectionReason(verificationError),
              });
              continue;
            }
            try {
              await scheduleSettingsBlockedRecovery({
                conversationId: row.conversationId,
                igUserId: row.igUserId,
                keywordId: convo.keywordId,
                keywordSnapshot: convo.keyword.keyword,
                commentId: row.commentId,
                mediaId: row.mediaId,
                verification,
              });
            } catch {
              await logEvent("dm_recovery_schedule_failed", {
                conversationId: row.conversationId,
                commentId: row.commentId,
                triggerKind: "settings_blocked",
              });
            }
          } else if (
            classification === "uncertain" ||
            classification === "transport_uncertain"
          ) {
            await prisma.gateQueue.update({
              where: { id: row.id },
              data: { status: "send_uncertain", attempts, lastError: metadata.category },
            });
            try {
              await scheduleTrackingUnavailableRecovery({
                conversationId: row.conversationId,
                igUserId: row.igUserId,
                keywordId: convo.keywordId,
                keywordSnapshot: convo.keyword.keyword,
                commentId: row.commentId,
                mediaId: row.mediaId,
            observedAt: new Date(),
              });
            } catch {
              await logEvent("dm_recovery_schedule_failed", {
                conversationId: row.conversationId,
                commentId: row.commentId,
                triggerKind: "tracking_unavailable",
              });
            }
          } else if (
            classification === "permanent" ||
            // Retrying a revoked or expired token cannot succeed: it burns the
            // attempt budget on every queued row and delays the operator noticing.
            classification === "permission_or_auth" ||
            attempts >= env.GATE_MAX_ATTEMPTS
          ) {
            await prisma.gateQueue.update({
              where: { id: row.id },
              data: { status: "exhausted", attempts, lastError: metadata.category },
            });
            if (classification === "permission_or_auth") {
              logger.error(
                {
                  errorCode: "gate_retry_auth_failure",
                  conversationId: row.conversationId,
                  graphCode: metadata.graphCode,
                  graphSubcode: metadata.graphSubcode,
                },
                "Gate retry retired: Instagram rejected the send as unauthorised",
              );
            }
          } else {
            // rate_limited or retryable_transport
            const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
            await prisma.gateQueue.update({
              where: { id: row.id },
              data: {
                status: "pending",
                attempts,
                lastError: metadata.category,
                nextAttemptAt: new Date(Date.now() + backoff),
              },
            });
          }

          // Only a genuine rate limit should stop the tick. This used to test for
          // subcode 2534025, which is "comment invalid for a private reply" — a
          // permanent, per-comment failure. One deleted or expired comment
          // therefore aborted every remaining queued send in the batch.
          if (classification === "rate_limited") {
            logger.info(
              { sentThisTick: sent, remaining: claimedRows.length - sent },
              "Gate retry hit rate limit — backing off for this tick",
            );
            break;
          }
        }
      }
    } finally {
      // The whole batch is claimed up front, so an early stop would strand the
      // untouched rows in `sending` until their lease expired and reconciliation
      // mislabelled them send_uncertain — rows that were never attempted at all.
      //
      // This must run even when the batch throws. The conversation load and the
      // missing/completed updates above are not individually guarded, so a
      // single database blip would otherwise strand every claimed row and then
      // record each one as a delivery that may have happened.
      const untouched = claimedRows.slice(processedCount);
      if (untouched.length > 0) {
        try {
          await prisma.gateQueue.updateMany({
            where: { id: { in: untouched.map((row) => row.id) }, status: "sending" },
            data: { status: "pending", claimedAt: null, claimExpiresAt: null },
          });
          logger.info(
            { released: untouched.length },
            "Released unattempted gate claims after an early batch stop",
          );
        } catch {
          // Releasing is itself a database write, so it can fail for the same
          // reason the batch did. Falling back to lease expiry is worse but not
          // silent.
          logger.error(
            { errorCode: "gate_claim_release_failed", stranded: untouched.length },
            "Failed to release unattempted gate claims",
          );
        }
      }
    }

    if (sent > 0) logger.info({ sent }, "Gate retry worker delivered queued gates");
  } catch (err) {
    logger.error(describeGraphError(err), "gateQueueWorker tick failed");
  }
}

/**
 * Measured experiment (off by default, GATE_DM_EXPERIMENT=true): for a couple of
 * already-exhausted users, try a STANDARD DM (recipient:{id}) — the channel we
 * believe Instagram blocks for cold users. Logged distinctly so we learn, at zero
 * cost, whether it's ever accepted. Never runs on fresh/pending users.
 */
async function maybeRunExperiment(): Promise<void> {
  if (!flags.bool("GATE_DM_EXPERIMENT")) return;
  try {
    const sample = await prisma.gateQueue.findMany({
      where: { status: "exhausted", lastError: { not: "experiment_done" } },
      orderBy: { updatedAt: "asc" },
      take: 2,
    });
    for (const row of sample) {
      try {
        await sendTrackedText({
          recipientIgUserId: row.igUserId,
          text: row.gateMessage,
          source: "keyword_automation",
        });
        await logEvent("gate_dm_experiment_ok", {
          conversationId: row.conversationId,
          igUserId: row.igUserId,
        });
      } catch (err) {
        await logEvent("gate_dm_experiment_failed", {
          conversationId: row.conversationId,
          igUserId: row.igUserId,
          ...describeGraphError(err),
        });
      }
      await prisma.gateQueue.update({
        where: { id: row.id },
        data: { lastError: "experiment_done" },
      });
      await sleep(PER_SEND_GAP_MS);
    }
  } catch (err) {
    logger.error(describeGraphError(err), "gate DM experiment failed");
  }
}
