import { isAxiosError } from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { sendTrackedPrivateReply, sendTrackedText } from "./dmDeliveryService.js";
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

// The rate-limit subcode. When we see it again we back off for the rest of the tick.
const RATE_LIMIT_SUBCODE = 2534025;

const BASE_BACKOFF_MS = 15 * 60 * 1000; // 15 min
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000; // 2 h
const PER_SEND_GAP_MS = 4000; // gentle spacing between sends within a tick

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const data = err.response?.data as { error?: { error_subcode?: number } } | undefined;
  return data?.error?.error_subcode === RATE_LIMIT_SUBCODE;
}

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

    // Load conversations and keywords
    const convos = await prisma.conversation.findMany({
      where: { id: { in: claimedRows.map((r) => r.conversationId) } },
      include: { keyword: true },
    });
    const convoMap = new Map(convos.map((c) => [c.id, c]));

    let sent = 0;
    for (const row of claimedRows) {
      const convo = convoMap.get(row.conversationId);
      if (!convo || !convo.keyword) {
        await prisma.gateQueue.update({
          where: { id: row.id },
          data: { status: "exhausted", lastError: "conversation_or_keyword_missing" },
        });
        continue;
      }

      if (convo.state === "completed") {
        await prisma.gateQueue.update({
          where: { id: row.id },
          data: { status: "abandoned", lastError: "conversation_completed" },
        });
        await logEvent("gate_abandoned", {
          conversationId: row.conversationId,
          reason: "conversation_completed",
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
        await logEvent("dm_sent", {
          conversationId: row.conversationId,
          kind: "gate",
          source: "retry",
        });

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
          try {
            await scheduleSettingsBlockedRecovery({
              conversationId: row.conversationId,
              igUserId: row.igUserId,
              keywordId: convo.keywordId,
              keywordSnapshot: convo.keyword.keyword,
              commentId: row.commentId,
              mediaId: row.mediaId,
              rejectedAt: new Date(),
            });
          } catch {
            await logEvent("dm_recovery_schedule_failed", {
              conversationId: row.conversationId,
              commentId: row.commentId,
              triggerKind: "settings_blocked",
            });
          }
        } else if (classification === "uncertain") {
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
            });
          } catch {
            await logEvent("dm_recovery_schedule_failed", {
              conversationId: row.conversationId,
              commentId: row.commentId,
              triggerKind: "tracking_unavailable",
            });
          }
        } else if (classification === "permanent" || attempts >= env.GATE_MAX_ATTEMPTS) {
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "exhausted", attempts, lastError: metadata.category },
          });
        } else {
          // rate_limited or retryable_transport or permission_or_auth
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

        if (isRateLimit(err)) {
          logger.info(
            { sentThisTick: sent, remaining: claimedRows.length - sent },
            "Gate retry hit rate limit — backing off for this tick",
          );
          break;
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
  if (!env.GATE_DM_EXPERIMENT) return;
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
