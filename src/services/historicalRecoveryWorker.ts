import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import { replyToComment } from "../meta/replyToComment.js";
import { fetchComment } from "../meta/fetchComment.js";
import { classifyPublicReplyFailure, classifySourceReadFailure } from "./graphErrorClassifier.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import { completeCampaignIfDrained } from "./recoveryCampaignControl.js";
import { evaluateCampaignHealth } from "./historicalRecoveryHealth.js";
import { recheckBeforeSend, type SourceCommentState } from "./historicalRecoveryRecheck.js";
import {
  type ClaimedCandidate,
  listDueCandidateIds,
  claimCandidate,
  reconcileExpiredCandidateLeases,
  releaseCandidateClaim,
  markCandidateSent,
  markCandidateSuppressed,
  markCandidateFailed,
  markCandidateUncertain,
  countCandidatesSentSince,
  reserveSendCapacity,
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

  // A lease that expired means the process died holding a claim. Rows where dispatch had
  // started are parked as uncertain, never retried — the comment may exist. Rows that
  // died while still PREPARING are released with a short backoff: Meta was never called,
  // so calling them uncertain would burn a valid candidate for a restart (QA-10).
  const reconciled = await reconcileExpiredCandidateLeases(now);
  if (reconciled.uncertain > 0 || reconciled.released > 0) {
    await logEvent("historical_recovery_stale_leases", {
      uncertain: reconciled.uncertain,
      released: reconciled.released,
    });
  }

  // Same circuit as the prospective path: an auth failure or a webhook gap should
  // stop BOTH kinds of send, since they share credentials and evidence.
  const health = await evaluateRecoveryHealth(now);
  if (health.circuitOpen) return empty("circuit_open");

  // The campaign's staged batch size governs this tick, capped by the env value as an
  // emergency global maximum (QA-08).
  //
  // The worker previously used only DM_RECOVERY_BATCH_SIZE, so advancing batch_size in
  // the dashboard or the API changed a stored number and nothing else — the staged
  // rollout the plan depends on had no effect at all. Verified in production: two
  // campaigns carried batch_size 1 and 5 while the worker sent 5 regardless.
  //
  // The smallest batch size among running campaigns wins, because a tick can span
  // campaigns and the conservative one must not be overrun by a larger sibling.
  const campaignBatch = await smallestRunningBatchSize();
  const batchSize = Math.min(campaignBatch ?? env.DM_RECOVERY_BATCH_SIZE, env.DM_RECOVERY_BATCH_SIZE);
  const ids = await listDueCandidateIds(now, batchSize);
  const leaseMs = env.DM_RECOVERY_LEASE_MS;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  /** Campaigns this tick touched, checked for completion once at the end. */
  const touchedCampaigns = new Set<string>();

  for (const id of ids) {
    // listDueCandidateIds over-fetches so a suppressed row does not consume a slot;
    // the cap has to be applied here or that headroom becomes extra public comments.
    if (result.sent >= batchSize) break;
    result.examined++;

    const claimed = await claimCandidate(id, now, new Date(now.getTime() + leaseMs));
    if (!claimed) continue;

    // Everything between the claim and the dispatch happens here, and a failure inside
    // is CONTAINED (QA-10).
    //
    // These reads previously ran bare in the loop, so a database blip after claiming
    // escaped to the tick's outer catch with the lease still held. Lease reconciliation
    // then marked the row `send_uncertain` — terminal, never retried — even though Meta
    // had never been contacted. A momentary database failure permanently burned a
    // candidate and recorded it as "we may have posted".
    //
    // Nothing in here reaches Meta except the source-comment READ, which is idempotent.
    // So any failure is provably pre-dispatch and the row is safe to hand back.
    let facts: PreDispatchFacts;
    try {
      facts = await gatherPreDispatchFacts(claimed, hourAgo, dayAgo);
    } catch (err) {
      logger.error(
        { errorCode: "historical_prepare_failed", candidateId: id, err: describeGraphError(err) },
        "Pre-dispatch checks failed; returning the candidate without judging it",
      );
      // Backoff rather than a bare release: whatever broke will likely still be broken
      // on the next tick, and an immediate re-pick would spin.
      await releaseCandidateClaim(id, claimed.claimToken, nextAttempt(claimed.attempts, now));
      result.deferred++;
      continue;
    }

    // An auth failure is not about this candidate: the token or a permission broke, and
    // every remaining row would fail the same way. Open the shared circuit so the tick
    // stops here rather than deferring 600 rows one at a time (QA-09).
    if (facts.sourceComment === "auth") {
      await openRecoveryCircuit("auth_or_permission", now);
      await releaseCandidateClaim(claimed.id, claimed.claimToken, now);
      result.deferred++;
      result.skipped = "source_read_auth_failed";
      break;
    }

    const decision = recheckBeforeSend({
      sourceComment: facts.sourceComment,
      repliedSinceSelection: facts.inboundCount > 0,
      completedSinceSelection: facts.completedCount > 0,
      contactedSinceSelection: facts.priorRecoveryCount > 0,
      audienceOrigin: facts.audienceOrigin,
      westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
      campaignRunning: facts.campaignState === "running",
      sentThisHour: facts.sentThisHour,
      hourlyCap: facts.hourlyCap,
      sentToday: facts.sentToday,
      dailyCap: facts.dailyCap,
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

    // Capacity is RESERVED, not merely observed (QA-08).
    //
    // The recheck above compared counts read moments earlier, with nothing holding the
    // gap: two workers could each read "2 of 3 this hour" and both post. This takes the
    // same `dm_recovery_control` lock the prospective path takes and stamps the row
    // in-flight inside it, so the slot is genuinely consumed before Meta is called and
    // the two systems serialise against each other rather than just counting each other.
    const refused = await reserveSendCapacity({
      candidateId: id,
      campaignId: claimed.campaignId,
      now,
      hourlyCap: facts.hourlyCap,
      dailyCap: facts.dailyCap,
      globalHourlyCap: env.DM_RECOVERY_HOURLY_CAP,
    });
    if (refused) {
      await releaseCandidateClaim(id, claimed.claimToken);
      result.deferred++;
      // A cap applies to every remaining row, so continuing would release them all
      // one at a time for nothing.
      result.skipped = refused;
      break;
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

    touchedCampaigns.add(claimed.campaignId);
  }

  // Close any campaign this tick finished (QA-12).
  //
  // `completeCampaignIfDrained` existed with NO production caller, so a campaign that
  // had sent everything sat `running` forever — the dashboard showed active work that
  // would never move, and nothing marked the campaign as having done its job.
  //
  // Here rather than per row: the last send of a campaign is only knowable after the
  // loop, and a per-row check would re-count the whole campaign on every send.
  //
  // Non-throwing, because a tick that sent successfully must not report failure just
  // because the bookkeeping afterwards broke.
  for (const campaignId of touchedCampaigns) {
    try {
      // Stop conditions BEFORE completion (QA-13). `evaluateRecoveryHealth` reads only
      // dm_recovery_reminder, so a historical campaign could be failing on real people's
      // public comments while the shared circuit stayed closed on a healthy prospective
      // feature. This is scoped to the campaign and pauses only that campaign — the
      // shared circuit stays reserved for genuinely shared faults like a broken token.
      //
      // Ordered first because a campaign that has just tripped a stop condition should
      // read as `paused`, not `completed`: completing it would hide the fault behind a
      // state that looks like success.
      const health = await evaluateCampaignHealth(campaignId, now);
      if (health.stopReason) {
        result.skipped = `campaign_auto_paused:${health.stopReason}`;
        continue;
      }

      await completeCampaignIfDrained(campaignId, now);
    } catch (err) {
      logger.error(
        { errorCode: "historical_campaign_bookkeeping_failed", campaignId },
        "Could not evaluate or close a campaign after the tick",
      );
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

/**
 * Everything the pre-send recheck needs, read fresh (QA-10).
 *
 * Extracted so its failure can be contained by the caller. Nothing here contacts Meta
 * except the source-comment read, which is a GET and idempotent — so a throw from this
 * function is provably pre-dispatch, and the claim can be handed back rather than parked
 * as `send_uncertain`.
 *
 * Throws on purpose. Returning partial facts would let the recheck run on defaults and
 * decide `send` against unread evidence.
 */
type PreDispatchFacts = {
  campaignState: string | null;
  hourlyCap: number;
  dailyCap: number;
  audienceOrigin: string | null;
  inboundCount: number;
  completedCount: number;
  priorRecoveryCount: number;
  sentThisHour: number;
  sentToday: number;
  sourceComment: SourceCommentState;
};

async function gatherPreDispatchFacts(
  claimed: ClaimedCandidate,
  hourAgo: Date,
  dayAgo: Date,
): Promise<PreDispatchFacts> {
  // All of these could have changed since selection, which is the whole reason §34
  // requires a recheck rather than trusting the snapshot.
  const [campaign, person, recentContact, sourceComment, capacity] = await Promise.all([
    prisma.recoveryCampaign.findUnique({
      where: { id: claimed.campaignId },
      select: { state: true, hourlyCap: true, dailyCap: true },
    }),
    prisma.igUser.findUnique({
      where: { id: claimed.igUserId },
      select: { inferredOrigin: true },
    }),
    // What has changed SINCE SELECTION, scoped to this person and this keyword (QA-11).
    //
    // All three of these previously asked "has this EVER happened", unscoped:
    //
    //   - any lifetime inbound counted as "they replied", so a DM from before the
    //     request suppressed the candidate. Measured: 4 eligible intents.
    //   - any completed conversation on ANY keyword counted as "they got it". Measured:
    //     64 of 2,413 candidates would have been silently suppressed at the final gate
    //     for completing an UNRELATED guide — the single largest defect in QA-11.
    //   - prior public recovery read only the prospective table, so a historical
    //     campaign's own send was invisible to the next one.
    //
    // The reminder says "I don't think my DM about SLEEP reached you". Someone who
    // downloaded the POTTY guide last week has not falsified that.
    Promise.all([
      prisma.dmMessage.count({
        where: {
          thread: { igUserId: claimed.igUserId },
          direction: "inbound",
          createdAt: { gte: claimed.selectedAt },
        },
      }),
      prisma.conversation.count({
        where: {
          igUserId: claimed.igUserId,
          keywordId: claimed.keywordId,
          state: "completed",
          completedAt: { gte: claimed.selectedAt },
        },
      }),
      // Both recovery systems, because either one posting publicly on this person is a
      // reason not to post again.
      Promise.all([
        prisma.dmRecoveryReminder.count({
          where: {
            igUserId: claimed.igUserId,
            status: { in: ["sent", "sending", "send_uncertain"] },
            OR: [
              { sentAt: { gte: claimed.selectedAt } },
              { lastAttemptAt: { gte: claimed.selectedAt } },
            ],
          },
        }),
        prisma.recoveryCandidate.count({
          where: {
            igUserId: claimed.igUserId,
            id: { not: claimed.id },
            OR: [
              { outcome: "sent", sentAt: { gte: claimed.selectedAt } },
              { outcome: "send_uncertain", lastAttemptAt: { gte: claimed.selectedAt } },
            ],
          },
        }),
      ]).then(([prospective, historical]) => prospective + historical),
    ]),
    // The Graph read that catches a deleted or hidden comment.
    readSourceComment(claimed.commentId),
    Promise.all([
      countCandidatesSentSince(claimed.campaignId, hourAgo),
      countCandidatesSentSince(claimed.campaignId, dayAgo),
    ]),
  ]);

  const [inboundCount, completedCount, priorRecoveryCount] = recentContact;
  const [sentThisHour, sentToday] = capacity;

  return {
    campaignState: campaign?.state ?? null,
    // Defaults match the conservative launch caps in design §39. A campaign row that
    // vanished mid-tick reads as not-running above, so these are only ever used for a
    // campaign whose caps were somehow null.
    hourlyCap: campaign?.hourlyCap ?? 3,
    dailyCap: campaign?.dailyCap ?? 10,
    audienceOrigin: person?.inferredOrigin ?? null,
    inboundCount,
    completedCount,
    priorRecoveryCount,
    sentThisHour,
    sentToday,
    sourceComment,
  };
}

/**
 * The smallest batch size among running campaigns, or null when none are running.
 *
 * Smallest rather than per-campaign because one tick can touch rows from several
 * campaigns, and a campaign still at stage 0 (batch 1) must not have its pacing
 * overridden by a sibling at stage 3.
 */
async function smallestRunningBatchSize(): Promise<number | null> {
  const row = await prisma.recoveryCampaign.aggregate({
    where: { state: "running" },
    _min: { batchSize: true },
  });
  return row._min.batchSize ?? null;
}
