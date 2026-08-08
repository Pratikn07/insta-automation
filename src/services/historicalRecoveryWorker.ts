import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import { replyToComment } from "../meta/replyToComment.js";
import { fetchComment } from "../meta/fetchComment.js";
import { classifyPublicReplyFailure, classifySourceReadFailure } from "./graphErrorClassifier.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import { recheckBeforeSend, type SourceCommentState } from "./historicalRecoveryRecheck.js";
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

/** Retry policy for a transient send failure. Mirrors the prospective worker's shape. */
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60 * 1000;

/**
 * When to try this row again: exponential with jitter, from the durable attempt count.
 *
 * Shared by the send-retry path and the source-read defer so both back off the same
 * way. Jittered because a rate limit hits many rows at once and a fixed delay would
 * bring them all back in lockstep.
 */
function nextAttempt(attempts: number, now: Date): Date {
  const ms = RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)) * (0.8 + Math.random() * 0.4);
  return new Date(now.getTime() + ms);
}

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
    const [campaign, person, recentContact, sourceComment] = await Promise.all([
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
      // The Graph read that catches a deleted or hidden comment.
      readSourceComment(claimed.commentId),
    ]);

    const [inboundCount, completedCount, priorRecoveryCount] = recentContact;
    const [sentThisHour, sentToday] = await Promise.all([
      countCandidatesSentSince(claimed.campaignId, hourAgo),
      countCandidatesSentSince(claimed.campaignId, dayAgo),
    ]);

    // An auth failure is not about this candidate: the token or a permission broke, and
    // every remaining row would fail the same way. Open the shared circuit so the tick
    // stops here rather than deferring 600 rows one at a time (QA-09).
    if (sourceComment === "auth") {
      await openRecoveryCircuit("auth_or_permission", now);
      await releaseCandidateClaim(claimed.id, claimed.claimToken, now);
      result.deferred++;
      result.skipped = "source_read_auth_failed";
      break;
    }

    const decision = recheckBeforeSend({
      sourceComment,
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
      // A failed source read gets durable backoff, matching the send path. Without it
      // a comment Meta keeps timing out on would be re-read on every tick forever,
      // spending quota on the same row and starving the rest of the queue (QA-09).
      //
      // Caps and pauses release with no backoff on purpose: they clear on a schedule
      // the row has no part in, and delaying the row would outlive the pause.
      if (decision.reason === "source_read_failed") {
        if (claimed.attempts >= MAX_ATTEMPTS) {
          // Still not terminal-as-deleted. The comment was never proven gone, so this
          // records why we stopped asking rather than claiming it does not exist.
          if (await markCandidateFailed(id, claimed.claimToken, "source_read_exhausted")) {
            result.failed++;
          }
          continue;
        }
        await releaseCandidateClaim(id, claimed.claimToken, nextAttempt(claimed.attempts, now));
        result.deferred++;
        continue;
      }

      await releaseCandidateClaim(id, claimed.claimToken);
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
      if (await markCandidateSuppressed(id, claimed.claimToken, decision.reason)) {
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
        await markCandidateFailed(id, claimed.claimToken, "auth_or_permission");
        await openRecoveryCircuit("auth_or_permission", now);
        result.failed++;
        break; // Credentials will not fix themselves inside this batch.
      }

      if (category === "permanent") {
        const reason = meta.graphCode ? `code_${meta.graphCode}` : "permanent";
        if (await markCandidateFailed(id, claimed.claimToken, reason)) {
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
        // Durable backoff with jitter, and a ceiling. Releasing the claim with no
        // record meant a rate-limited row was retried on every tick indefinitely.
        if (claimed.attempts >= MAX_ATTEMPTS) {
          if (await markCandidateFailed(id, claimed.claimToken, "rate_limit_exhausted")) {
            result.failed++;
          }
          continue;
        }
        await releaseCandidateClaim(id, claimed.claimToken, nextAttempt(claimed.attempts, now));
        result.deferred++;
        continue;
      }

      // Timeout, reset, or anything unrecognised: the comment may have posted, so
      // never retried automatically.
      if (await markCandidateUncertain(id, claimed.claimToken, meta.category ?? "unknown")) {
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
      if (await markCandidateUncertain(id, claimed.claimToken, "missing_reply_id")) {
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

    if (await markCandidateSent(id, claimed.claimToken, { publicReplyId: replyId, sentAt: new Date() })) {
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

/**
 * Read the source comment and report what we actually learned (QA-09).
 *
 * `fetchComment` throws so the caller can tell a confirmed deletion from a network
 * failure. This worker previously discarded that distinction — `.catch(() => null)`
 * turned every failure into "not there", which the recheck read as terminal
 * `source_comment_deleted`. A timeout, a 429, a Meta 5xx, an expired token, or a
 * permission regression therefore permanently suppressed a candidate whose comment was
 * perfectly fine, and inflated the source-unavailable metric with failures that said
 * nothing about the comment.
 *
 * Never throws: a read failure classifies, it does not abort the tick.
 */
async function readSourceComment(commentId: string): Promise<SourceCommentState> {
  try {
    const comment = await fetchComment(commentId);
    return comment.hidden ? "hidden" : "visible";
  } catch (err) {
    const metadata = describeGraphError(err);
    const failure = classifySourceReadFailure(metadata);

    // Logged for every non-missing case, because these are the ones that used to
    // disappear as false deletions. The metadata is the safe numeric shape only.
    if (failure !== "missing") {
      logger.warn(
        { errorCode: "historical_source_read_failed", failure, err: metadata },
        "Could not read the source comment; deferring rather than suppressing",
      );
    }

    if (failure === "auth") return "auth";
    if (failure === "missing") return "missing";
    return "unknown";
  }
}
