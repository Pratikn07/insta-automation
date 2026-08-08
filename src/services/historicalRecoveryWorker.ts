import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import { replyToComment } from "../meta/replyToComment.js";
import { fetchComment } from "../meta/fetchComment.js";
import { classifyPublicReplyFailure } from "./graphErrorClassifier.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import { recheckBeforeSend } from "./historicalRecoveryRecheck.js";
import {
  listDueCandidateIds,
  claimCandidate,
  reconcileExpiredCandidateLeases,
  releaseCandidateClaim,
  markCandidateSent,
  markCandidateSuppressed,
  markCandidateFailed,
  markCandidateUncertain,
  countCandidatesSentSince,
} from "./historicalRecoveryRepository.js";

/**
 * Send historical recovery reminders for approved, running campaigns.
 *
 * Shares the prospective path's circuit breaker, failure classification, lease
 * discipline, and uncertain-never-retried rule — so a safety fix made there applies
 * here too. What differs is the MEANING: these are old requests, selected once and
 * frozen, so the pre-send recheck carries more weight than in the prospective case
 * where selection and send are seconds apart.
 *
 * Non-throwing. A tick that fails must not take the process down.
 */

export type HistoricalTickResult = {
  examined: number;
  sent: number;
  suppressed: number;
  deferred: number;
  failed: number;
  uncertain: number;
  skipped?: string;
};

function empty(skipped?: string): HistoricalTickResult {
  return { examined: 0, sent: 0, suppressed: 0, deferred: 0, failed: 0, uncertain: 0, skipped };
}

export async function runHistoricalRecoveryTick(): Promise<HistoricalTickResult> {
  try {
    return await runTickBody();
  } catch (err) {
    logger.error(
      { errorCode: "historical_recovery_tick_failed", err: describeGraphError(err) },
      "Historical recovery tick failed",
    );
    return empty("tick_failed");
  }
}

async function runTickBody(): Promise<HistoricalTickResult> {
  const now = new Date();
  const result = empty();

  // Two switches, both required. DM_RECOVERY_ENABLED is the master stop shared with
  // the prospective feature; DM_RECOVERY_HISTORICAL_ENABLED is specific to these
  // sends, which contact people about requests weeks old. Either being off means
  // nothing is posted.
  if (!env.DM_RECOVERY_ENABLED) return empty("disabled");
  if (!env.DM_RECOVERY_HISTORICAL_ENABLED) return empty("historical_disabled");

  // A lease that expired means the process died mid-send. The comment may have
  // posted, so these are parked as uncertain, never retried.
  const reconciled = await reconcileExpiredCandidateLeases(now);
  if (reconciled > 0) {
    await logEvent("historical_recovery_stale_leases", { count: reconciled });
  }

  // Same circuit as the prospective path: an auth failure or a webhook gap should
  // stop BOTH kinds of send, since they share credentials and evidence.
  const health = await evaluateRecoveryHealth(now);
  if (health.circuitOpen) return empty("circuit_open");

  const batchSize = env.DM_RECOVERY_BATCH_SIZE;
  const ids = await listDueCandidateIds(now, batchSize);
  const leaseMs = env.DM_RECOVERY_LEASE_MS;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const id of ids) {
    // listDueCandidateIds over-fetches so a suppressed row does not consume a slot;
    // the cap has to be applied here or that headroom becomes extra public comments.
    if (result.sent >= batchSize) break;
    result.examined++;

    const claimed = await claimCandidate(id, now, new Date(now.getTime() + leaseMs));
    if (!claimed) continue;

    // Read the live facts. All of these could have changed since selection, which is
    // the whole reason §34 requires a recheck rather than trusting the snapshot.
    const [campaign, person, recentContact, liveComment] = await Promise.all([
      prisma.recoveryCampaign.findUnique({
        where: { id: claimed.campaignId },
        select: { state: true, hourlyCap: true, dailyCap: true },
      }),
      prisma.igUser.findUnique({
        where: { id: claimed.igUserId },
        select: { inferredOrigin: true },
      }),
      // Any inbound, completion, or other public recovery since selection.
      Promise.all([
        prisma.dmMessage.count({
          where: { thread: { igUserId: claimed.igUserId }, direction: "inbound" },
        }),
        prisma.conversation.count({
          where: { igUserId: claimed.igUserId, state: "completed" },
        }),
        prisma.dmRecoveryReminder.count({
          where: { igUserId: claimed.igUserId, status: { in: ["sent", "sending", "send_uncertain"] } },
        }),
      ]),
      // The Graph read that catches a deleted or hidden comment. Non-throwing: a
      // lookup failure must not be read as "the comment is fine".
      fetchComment(claimed.commentId).catch(() => null),
    ]);

    const [inboundCount, completedCount, priorRecoveryCount] = recentContact;
    const [sentThisHour, sentToday] = await Promise.all([
      countCandidatesSentSince(claimed.campaignId, hourAgo),
      countCandidatesSentSince(claimed.campaignId, dayAgo),
    ]);

    const decision = recheckBeforeSend({
      commentStillExists: liveComment !== null,
      commentHidden: liveComment?.hidden === true,
      repliedSinceSelection: inboundCount > 0,
      completedSinceSelection: completedCount > 0,
      contactedSinceSelection: priorRecoveryCount > 0,
      audienceOrigin: person?.inferredOrigin ?? null,
      westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
      campaignRunning: campaign?.state === "running",
      sentThisHour,
      hourlyCap: campaign?.hourlyCap ?? 3,
      sentToday,
      dailyCap: campaign?.dailyCap ?? 10,
    });

    if (decision.kind === "defer") {
      await releaseCandidateClaim(id);
      result.deferred++;
      // A cap or a pause applies to the whole campaign, so continuing the loop
      // would just release every remaining row one at a time.
      if (
        decision.reason === "hourly_cap_reached" ||
        decision.reason === "daily_cap_reached" ||
        decision.reason === "campaign_not_running"
      ) {
        result.skipped = decision.reason;
        break;
      }
      continue;
    }

    if (decision.kind === "suppress") {
      if (await markCandidateSuppressed(id, decision.reason)) {
        result.suppressed++;
        await logEvent("historical_recovery_suppressed", {
          candidateId: id,
          campaignId: claimed.campaignId,
          igUserId: claimed.igUserId,
          reason: decision.reason,
        });
      }
      continue;
    }

    // Only an explicit `send` reaches Meta. Written as a positive check so any
    // decision kind added later defaults to NOT posting publicly.
    let replyId: string | null = null;
    let sendError: unknown = null;
    try {
      const reply = await replyToComment(claimed.commentId, claimed.publicReplyText);
      replyId = reply.replyId;
    } catch (error) {
      sendError = error;
    }

    if (sendError) {
      const meta = describeGraphError(sendError);
      const category = classifyPublicReplyFailure(meta);

      if (category === "open_circuit") {
        await markCandidateFailed(id, "auth_or_permission");
        await openRecoveryCircuit("auth_or_permission", now);
        result.failed++;
        break; // Credentials will not fix themselves inside this batch.
      }

      if (category === "permanent") {
        const reason = meta.graphCode ? `code_${meta.graphCode}` : "permanent";
        if (await markCandidateFailed(id, reason)) {
          result.failed++;
          await logEvent("historical_recovery_send_failed", {
            candidateId: id,
            campaignId: claimed.campaignId,
            igUserId: claimed.igUserId,
            category: reason,
          });
        }
        continue;
      }

      // safe_retry lands here too. Unlike the prospective path there is no retry
      // schedule on a candidate, so a retryable failure releases the claim and the
      // row is simply picked up on a later tick.
      if (category === "safe_retry") {
        await releaseCandidateClaim(id);
        result.deferred++;
        continue;
      }

      // Timeout, reset, or anything unrecognised: the comment may have posted, so
      // never retried automatically.
      if (await markCandidateUncertain(id, meta.category ?? "unknown")) {
        result.uncertain++;
        await logEvent("historical_recovery_send_uncertain", {
          candidateId: id,
          campaignId: claimed.campaignId,
          igUserId: claimed.igUserId,
          category: meta.category ?? "unknown",
        });
      }
      continue;
    }

    // Meta accepted the post but returned no id. The comment probably exists and we
    // cannot prove it, and chk_candidate_sent_has_reply_id would reject `sent`
    // anyway — so this is uncertain, not sent.
    if (!replyId) {
      if (await markCandidateUncertain(id, "missing_reply_id")) {
        result.uncertain++;
        await logEvent("historical_recovery_send_uncertain", {
          candidateId: id,
          campaignId: claimed.campaignId,
          igUserId: claimed.igUserId,
          category: "missing_reply_id",
        });
      }
      continue;
    }

    if (await markCandidateSent(id, { publicReplyId: replyId, sentAt: new Date() })) {
      result.sent++;
      await logEvent("historical_recovery_sent", {
        candidateId: id,
        campaignId: claimed.campaignId,
        igUserId: claimed.igUserId,
        commentId: claimed.commentId,
        publicReplyId: replyId,
        evidence: claimed.evidence,
        arm: claimed.arm,
      });
    } else {
      // The row moved underneath us after a successful post. Recorded rather than
      // silently dropped: the comment IS live on Instagram.
      await logEvent("historical_recovery_finalize_failed", {
        candidateId: id,
        campaignId: claimed.campaignId,
        publicReplyId: replyId,
      });
    }
  }

  return result;
}
