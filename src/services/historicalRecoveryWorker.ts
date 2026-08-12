import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "./eventLogger.js";
import { replyToComment } from "../meta/replyToComment.js";
import { fetchComment } from "../meta/fetchComment.js";
import { classifyPublicReplyFailure, classifySourceReadFailure } from "./graphErrorClassifier.js";
import { evaluateRecoveryHealth, openRecoveryCircuit } from "./dmRecoveryHealth.js";
import {
  completeCampaignIfDrained,
  reconcileDrainedCampaigns,
} from "./recoveryCampaignControl.js";
import { evaluateCampaignHealth } from "./historicalRecoveryHealth.js";
import { reconcilePendingInboundCampaignHealthSignals } from "./campaignHealthObservation.js";
import { reconcileHistoricalRecoveryAttributionSafely } from "./historicalRecoveryAttribution.js";
import { recheckBeforeSend, type SourceCommentState } from "./historicalRecoveryRecheck.js";
import { resolveApprovedHistoricalSource } from "./historicalRecoverySourceChoice.js";
import {
  type ClaimedCandidate,
  listDueCandidateIds,
  claimCandidate,
  reconcileExpiredCandidateLeases,
  releaseCandidateClaim,
  markCandidateSuppressed,
  markCandidateFailed,
  countCandidatesSentSince,
  reserveHistoricalDispatch,
  startHistoricalDispatch,
  releaseHistoricalReservation,
  finalizeHistoricalDispatch,
} from "./historicalRecoveryRepository.js";
import {
  acquireHistoricalTick,
  finishHistoricalTick,
  openCampaignBatch,
  type HistoricalTickLease,
} from "./historicalRecoveryTickRepository.js";

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

  // Two switches, both required. DM_RECOVERY_ENABLED is the master stop shared with
  // the prospective feature; DM_RECOVERY_HISTORICAL_ENABLED is specific to these
  // sends, which contact people about requests weeks old. Either being off means
  // nothing is posted.
  if (!env.DM_RECOVERY_ENABLED) return empty("disabled");
  if (!env.DM_RECOVERY_HISTORICAL_ENABLED) return empty("historical_disabled");

  const tick = await acquireHistoricalTick(
    now,
    new Date(now.getTime() + env.DM_RECOVERY_LEASE_MS),
  );
  if (!tick) return empty("tick_already_running");

  try {
    return await runLeasedTickBody(now, tick);
  } finally {
    try {
      await finishHistoricalTick(tick.token, new Date());
    } catch {
      // Lease expiry is the crash fallback. Keep the result truthful when sends already
      // completed, while making the failed cleanup visible without logging DB detail.
      logger.error(
        { errorCode: "historical_tick_finish_failed" },
        "Historical recovery tick lease could not be cleared",
      );
    }
  }
}

async function runLeasedTickBody(
  now: Date,
  tick: HistoricalTickLease,
): Promise<HistoricalTickResult> {
  const result = empty();

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

  // Live attribution can race finalization or fail after the source event commits.
  // Replaying durable DM/conversation evidence on every leased tick closes both gaps.
  await reconcileHistoricalRecoveryAttributionSafely();

  // Independent of rows touched by this process. A previous worker may have committed
  // the final outcome and exited before campaign completion bookkeeping.
  await reconcileDrainedCampaigns(now);

  // The webhook endpoint acknowledges before handler work, so a transient health-write
  // failure cannot rely on Meta replay. New inbound rows are a durable safety inbox.
  // Drain it before any batch opens and fail closed while a row failed or more remain.
  const inboundHealth = await reconcilePendingInboundCampaignHealthSignals(now);
  if (inboundHealth.failed > 0) return empty("campaign_health_capture_failed");
  if (inboundHealth.remaining) return empty("campaign_health_capture_pending");

  // Same circuit as the prospective path: an auth failure or a webhook gap should
  // stop BOTH kinds of send, since they share credentials and evidence.
  const health = await evaluateRecoveryHealth(now);
  if (health.circuitOpen) return empty("circuit_open");

  const stoppedCampaigns = new Set<string>();

  // Each running campaign gets its own durable batch row. A small pilot no longer
  // throttles an unrelated campaign, and the allowance is enforced again under the
  // final dispatch-start locks rather than trusted to this in-memory loop.
  const runningCampaigns = await prisma.recoveryCampaign.findMany({
    where: { state: "running" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const work: Array<{
    id: string;
    campaignId: string;
    batchRunId: string;
    allowance: number;
  }> = [];
  for (const campaign of runningCampaigns) {
    try {
      const campaignHealth = await evaluateCampaignHealth(campaign.id, new Date());
      if (campaignHealth.stopReason) {
        stoppedCampaigns.add(campaign.id);
        result.skipped = `campaign_auto_paused:${campaignHealth.stopReason}`;
        continue;
      }
    } catch {
      // Unknown health is not permission to post. Stop this campaign before even
      // opening a batch; other campaigns get their own independent check.
      stoppedCampaigns.add(campaign.id);
      result.skipped = "campaign_health_check_failed";
      logger.error(
        { errorCode: "historical_campaign_health_check_failed", campaignId: campaign.id },
        "Could not evaluate campaign health before dispatch",
      );
      continue;
    }
    const batch = await openCampaignBatch(tick, campaign.id, now);
    if (!batch) continue;
    const ids = await listDueCandidateIds(now, batch.allowance, campaign.id);
    for (const id of ids) {
      work.push({ id, campaignId: campaign.id, batchRunId: batch.id, allowance: batch.allowance });
    }
  }
  const leaseMs = env.DM_RECOVERY_LEASE_MS;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  /**
   * Campaigns this tick JUDGED, checked for health and completion once at the end.
   *
   * A campaign belongs here as soon as one of its rows reached an outcome — suppressed,
   * failed, or dispatched — not only when a send succeeded. That distinction is the whole
   * point: the stop conditions exist for campaigns going wrong, and a campaign going
   * wrong is precisely one that is not sending. Registering only on success made
   * `evaluateCampaignHealth` unreachable at a 100% failure rate, and made
   * `source_unavailable_rate` dead code — `chooseStopReason` evaluates it at
   * `settled == 0` on purpose, for a cohort whose comments have all been deleted, and
   * such a campaign never posts anything at all.
   *
   * Deferrals are excluded: a cap, a pause, or a failed source read judges nothing about
   * the row, so no observation the health check reads has changed.
   */
  const campaignsToEvaluate = new Set<string>();
  const campaignDispatchStarts = new Map<string, number>();

  const observeTerminalOutcome = async (campaignId: string): Promise<void> => {
    campaignsToEvaluate.add(campaignId);
    try {
      const health = await evaluateCampaignHealth(campaignId, new Date());
      if (health.stopReason) {
        stoppedCampaigns.add(campaignId);
        result.skipped = `campaign_auto_paused:${health.stopReason}`;
      }
    } catch {
      stoppedCampaigns.add(campaignId);
      result.skipped = "campaign_health_check_failed";
      logger.error(
        { errorCode: "historical_campaign_health_check_failed", campaignId },
        "Could not evaluate campaign health after a terminal outcome",
      );
    }
  };

  for (const item of work) {
    const { id } = item;
    if (stoppedCampaigns.has(item.campaignId)) continue;
    // listDueCandidateIds over-fetches so a suppressed row does not consume a slot;
    // dispatch starts, not successful replies, consume the durable allowance.
    if ((campaignDispatchStarts.get(item.campaignId) ?? 0) >= item.allowance) continue;
    result.examined++;

    const claimAt = new Date();
    const claimed = await claimCandidate(
      id,
      claimAt,
      new Date(claimAt.getTime() + leaseMs),
    );
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
      audienceOriginConfidence: facts.audienceOriginConfidence,
      audienceOriginMethod: facts.audienceOriginMethod,
      audienceSegment: facts.audienceSegment,
      frozenCandidateAudienceSegment: facts.frozenCandidateAudienceSegment,
      frozenCampaignAudienceSegment: facts.frozenCampaignAudienceSegment,
      // Retained as part of the immutable campaign manifest, but cannot relax the
      // mandatory current-Gemini historical public-comment gate.
      westernOnly: facts.approvedWesternOnly === true || env.DM_RECOVERY_WESTERN_ONLY,
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
            await observeTerminalOutcome(claimed.campaignId);
          }
          continue;
        }
        await releaseCandidateClaim(id, claimed.claimToken, nextAttempt(claimed.attempts, now));
        result.deferred++;
        continue;
      }

      await releaseCandidateClaim(id, claimed.claimToken);
      result.deferred++;
      if (
        decision.reason === "origin_not_current_gemini"
        || decision.reason === "audience_segment_changed"
      ) {
        await logEvent("historical_recovery_deferred", {
          campaignId: claimed.campaignId,
          candidateId: id,
          reason: decision.reason,
          boundary: "advisory_pre_reservation",
        });
      }
      // A cap or a pause applies to the whole campaign, so continuing the loop
      // would just release every remaining row one at a time.
      if (
        decision.reason === "hourly_cap_reached" ||
        decision.reason === "daily_cap_reached" ||
        decision.reason === "campaign_not_running"
      ) {
        result.skipped = decision.reason;
        stoppedCampaigns.add(item.campaignId);
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
        await observeTerminalOutcome(claimed.campaignId);
      }
      continue;
    }

    // TypeScript narrows the declared union above, but this boundary receives a runtime
    // result. Only a literal send result may consume capacity; malformed or future
    // kinds are returned to the queue without making a public provider call.
    if (decision.kind === "send") {
      // The exact allowlist continues into the reservation below.
    } else {
      const kind = typeof (decision as { kind?: unknown }).kind === "string"
        ? (decision as { kind: string }).kind
        : "invalid";
      logger.error(
        { errorCode: "historical_recheck_unexpected_result", kind },
        "Historical recovery recheck returned an unexpected result",
      );
      await releaseCandidateClaim(id, claimed.claimToken);
      result.deferred++;
      continue;
    }

    // Capacity is RESERVED, not merely observed (QA-08).
    //
    // The recheck above compared counts read moments earlier, with nothing holding the
    // gap: two workers could each read "2 of 3 this hour" and both post. This takes the
    // same `dm_recovery_control` lock the prospective path takes and stamps the row
    // in-flight inside it, so the slot is genuinely consumed before Meta is called and
    // the two systems serialise against each other rather than just counting each other.
    const reservationAt = new Date();
    const reservation = await reserveHistoricalDispatch({
      candidateId: id,
      claimToken: claimed.claimToken,
      now: reservationAt,
      hourlyCap: facts.hourlyCap,
      dailyCap: facts.dailyCap,
      globalHourlyCap: env.DM_RECOVERY_HOURLY_CAP,
      globalDailyCap: env.DM_RECOVERY_GLOBAL_DAILY_CAP,
      prospectiveCooldownHours: env.DM_RECOVERY_COOLDOWN_HOURS ?? 24,
    });
    if (reservation.kind === "blocked") {
      if (
        reservation.reason === "person_cooldown" ||
        reservation.reason === "reconciled_alias"
      ) {
        if (await markCandidateSuppressed(id, claimed.claimToken, reservation.reason)) {
          result.suppressed++;
          await observeTerminalOutcome(claimed.campaignId);
        }
        continue;
      }
      await releaseCandidateClaim(id, claimed.claimToken);
      result.deferred++;
      if (
        reservation.reason === "hourly_cap_reached" ||
        reservation.reason === "daily_cap_reached"
      ) {
        result.skipped = reservation.reason;
        stoppedCampaigns.add(item.campaignId);
        continue;
      }
      if (
        reservation.reason === "global_hourly_cap_reached" ||
        reservation.reason === "global_daily_cap_reached" ||
        reservation.reason === "rollout_group_hourly_cap_reached" ||
        reservation.reason === "circuit_open"
      ) {
        result.skipped = reservation.reason;
        break;
      }
      continue;
    }

    const dispatchStart = await startHistoricalDispatch({
      candidateId: id,
      claimToken: claimed.claimToken,
      batchRunId: item.batchRunId,
      dispatchId: reservation.dispatchId,
      reservationToken: reservation.reservationToken,
      commentId: facts.sourceCommentId!,
      currentWesternOnly: env.DM_RECOVERY_WESTERN_ONLY,
      now: new Date(),
    });
    if (dispatchStart.kind === "suppressed") {
      result.suppressed++;
      await logEvent("historical_recovery_suppressed", {
        candidateId: id,
        campaignId: claimed.campaignId,
        igUserId: claimed.igUserId,
        reason: dispatchStart.reason,
        boundary: "final_locked_authorization",
      });
      await observeTerminalOutcome(claimed.campaignId);
      continue;
    }
    if (dispatchStart.kind === "deferred") {
      // The final locked authorization released the reservation and claim atomically.
      // Do not call the provider, and do not release a second time with a stale token.
      result.deferred++;
      await logEvent("historical_recovery_deferred", {
        campaignId: claimed.campaignId,
        candidateId: id,
        reason: dispatchStart.reason,
        boundary: "final_locked_authorization",
      });
      continue;
    }
    if (dispatchStart.kind === "blocked") {
      await releaseHistoricalReservation({
        candidateId: id,
        claimToken: claimed.claimToken,
        dispatchId: reservation.dispatchId,
        reservationToken: reservation.reservationToken,
        at: new Date(),
        reason: `dispatch_start_rejected:${dispatchStart.reason}`,
      });
      result.deferred++;
      if (
        dispatchStart.reason === "circuit_open" ||
        dispatchStart.reason === "campaign_health_capture_pending" ||
        dispatchStart.reason === "batch_not_active" ||
        dispatchStart.reason === "campaign_policy_incomplete"
      ) {
        result.skipped = dispatchStart.reason;
        break;
      }
      if (
        dispatchStart.reason === "campaign_not_running" ||
        dispatchStart.reason === "campaign_batch_exhausted"
      ) {
        stoppedCampaigns.add(item.campaignId);
      }
      continue;
    }

    // `startHistoricalDispatch` is an I/O boundary despite its declared union. Only
    // its explicit started result may enter the provider path; any malformed/future
    // result releases the reservation and candidate claim through the fenced helper.
    if (dispatchStart.kind === "started") {
      // The exact allowlist continues into the provider path below.
    } else {
      const kind = typeof (dispatchStart as { kind?: unknown }).kind === "string"
        ? (dispatchStart as { kind: string }).kind
        : "invalid";
      logger.error(
        { errorCode: "historical_dispatch_start_unexpected_result", kind },
        "Historical recovery dispatch start returned an unexpected result",
      );
      await releaseHistoricalReservation({
        candidateId: id,
        claimToken: claimed.claimToken,
        dispatchId: reservation.dispatchId,
        reservationToken: reservation.reservationToken,
        at: new Date(),
        reason: `dispatch_start_unexpected_result:${kind}`,
      });
      result.deferred++;
      continue;
    }
    campaignDispatchStarts.set(
      item.campaignId,
      (campaignDispatchStarts.get(item.campaignId) ?? 0) + 1,
    );

    // Only an explicit `send` reaches Meta. Written as a positive check so any
    // decision kind added later defaults to NOT posting publicly.
    let replyId: string | null = null;
    let sendError: unknown = null;
    try {
      const reply = await replyToComment(facts.sourceCommentId!, claimed.publicReplyText);
      replyId = reply.replyId;
    } catch (error) {
      sendError = error;
    }

    if (sendError) {
      const meta = describeGraphError(sendError);
      const category = classifyPublicReplyFailure(meta);

      if (category === "open_circuit") {
        const finalized = await finalizeHistoricalDispatch({
          candidateId: id,
          claimToken: claimed.claimToken,
          dispatchId: reservation.dispatchId,
          reservationToken: reservation.reservationToken,
          outcome: { kind: "failed", at: new Date(), reason: "auth_or_permission" },
        });
        if (finalized) await observeTerminalOutcome(claimed.campaignId);
        await openRecoveryCircuit("auth_or_permission", now);
        result.failed++;
        break; // Credentials will not fix themselves inside this batch.
      }

      if (category === "permanent") {
        const reason = meta.graphCode ? `code_${meta.graphCode}` : "permanent";
        if (await finalizeHistoricalDispatch({
          candidateId: id,
          claimToken: claimed.claimToken,
          dispatchId: reservation.dispatchId,
          reservationToken: reservation.reservationToken,
          outcome: { kind: "failed", at: new Date(), reason },
        })) {
          result.failed++;
          await logEvent("historical_recovery_send_failed", {
            candidateId: id,
            campaignId: claimed.campaignId,
            igUserId: claimed.igUserId,
            category: reason,
          });
          await observeTerminalOutcome(claimed.campaignId);
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
          if (await finalizeHistoricalDispatch({
            candidateId: id,
            claimToken: claimed.claimToken,
            dispatchId: reservation.dispatchId,
            reservationToken: reservation.reservationToken,
            outcome: { kind: "failed", at: new Date(), reason: "rate_limit_exhausted" },
          })) {
            result.failed++;
            await observeTerminalOutcome(claimed.campaignId);
          }
          continue;
        }
        await finalizeHistoricalDispatch({
          candidateId: id,
          claimToken: claimed.claimToken,
          dispatchId: reservation.dispatchId,
          reservationToken: reservation.reservationToken,
          outcome: {
            kind: "released",
            at: new Date(),
            reason: "rate_limit",
            nextAttemptAt: nextAttempt(claimed.attempts, now),
          },
        });
        result.deferred++;
        continue;
      }

      // Timeout, reset, or anything unrecognised: the comment may have posted, so
      // never retried automatically.
      if (await finalizeHistoricalDispatch({
        candidateId: id,
        claimToken: claimed.claimToken,
        dispatchId: reservation.dispatchId,
        reservationToken: reservation.reservationToken,
        outcome: { kind: "uncertain", reason: meta.category ?? "unknown" },
      })) {
        result.uncertain++;
        await logEvent("historical_recovery_send_uncertain", {
          candidateId: id,
          campaignId: claimed.campaignId,
          igUserId: claimed.igUserId,
          category: meta.category ?? "unknown",
        });
        await observeTerminalOutcome(claimed.campaignId);
      }
      continue;
    }

    // Meta accepted the post but returned no id. The comment probably exists and we
    // cannot prove it, and chk_candidate_sent_has_reply_id would reject `sent`
    // anyway — so this is uncertain, not sent.
    if (!replyId) {
      if (await finalizeHistoricalDispatch({
        candidateId: id,
        claimToken: claimed.claimToken,
        dispatchId: reservation.dispatchId,
        reservationToken: reservation.reservationToken,
        outcome: { kind: "uncertain", reason: "missing_reply_id" },
      })) {
        result.uncertain++;
        await logEvent("historical_recovery_send_uncertain", {
          candidateId: id,
          campaignId: claimed.campaignId,
          igUserId: claimed.igUserId,
          category: "missing_reply_id",
        });
        await observeTerminalOutcome(claimed.campaignId);
      }
      continue;
    }

    if (await finalizeHistoricalDispatch({
      candidateId: id,
      claimToken: claimed.claimToken,
      dispatchId: reservation.dispatchId,
      reservationToken: reservation.reservationToken,
      outcome: { kind: "sent", at: new Date(), providerReplyId: replyId },
    })) {
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
      await observeTerminalOutcome(claimed.campaignId);
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

  // Pick up events that landed after dispatch-start but before this tick finalized the
  // candidate. A failure is logged and retried by the next tick's replay above.
  await reconcileHistoricalRecoveryAttributionSafely();

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
  for (const campaignId of campaignsToEvaluate) {
    try {
      if (stoppedCampaigns.has(campaignId)) continue;
      await completeCampaignIfDrained(campaignId, now);
    } catch (err) {
      logger.error(
        { errorCode: "historical_campaign_bookkeeping_failed", campaignId },
        "Could not evaluate or close a campaign after the tick",
      );
    }
  }

  await reconcileDrainedCampaigns(now);

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
  audienceOriginConfidence: string | null;
  audienceOriginMethod: string | null;
  audienceSegment: string | null;
  frozenCandidateAudienceSegment: string | null;
  frozenCampaignAudienceSegment: string | null;
  approvedWesternOnly: boolean | null;
  inboundCount: number;
  completedCount: number;
  priorRecoveryCount: number;
  sentThisHour: number;
  sentToday: number;
  sourceComment: SourceCommentState;
  sourceCommentId: string | null;
};

async function gatherPreDispatchFacts(
  claimed: ClaimedCandidate,
  hourAgo: Date,
  dayAgo: Date,
): Promise<PreDispatchFacts> {
  // All of these could have changed since selection, which is the whole reason §34
  // requires a recheck rather than trusting the snapshot.
  const [campaign, person, recentContact, sourceResolution, capacity] = await Promise.all([
    prisma.recoveryCampaign.findUnique({
      where: { id: claimed.campaignId },
      select: {
        state: true,
        hourlyCap: true,
        dailyCap: true,
        westernOnly: true,
        audienceSegment: true,
      },
    }),
    prisma.igUser.findUnique({
      where: { id: claimed.igUserId },
      select: {
        inferredOrigin: true,
        originConfidence: true,
        originMethod: true,
        audienceSegment: true,
      },
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
      // The shared ledger is the only cooldown authority. It contains both recovery
      // systems, so this advisory recheck cannot drift from the locked reservation.
      prisma.publicRecoveryDispatch.count({
        where: {
          igUserId: claimed.igUserId,
          state: { in: ["sent", "uncertain"] },
          dispatchStartedAt: { gte: claimed.selectedAt },
        },
      }),
    ]),
    // Resolve only within the immutable source set the owner reviewed. Definitive
    // absence may advance; auth/transient/unknown reads never redirect a public reply.
    resolveApprovedHistoricalSource(claimed.sources, readSourceComment),
    Promise.all([
      countCandidatesSentSince(claimed.campaignId, hourAgo),
      countCandidatesSentSince(claimed.campaignId, dayAgo),
    ]),
  ]);

  const [inboundCount, completedCount, priorRecoveryCount] = recentContact;
  const [sentThisHour, sentToday] = capacity;
  const sourceComment: SourceCommentState = sourceResolution.kind === "selected"
    ? "visible"
    : sourceResolution.reason;

  return {
    campaignState: campaign?.state ?? null,
    // Defaults match the conservative launch caps in design §39. A campaign row that
    // vanished mid-tick reads as not-running above, so these are only ever used for a
    // campaign whose caps were somehow null.
    hourlyCap: campaign?.hourlyCap ?? 3,
    dailyCap: campaign?.dailyCap ?? 10,
    audienceOrigin: person?.inferredOrigin ?? null,
    audienceOriginConfidence: person?.originConfidence ?? null,
    audienceOriginMethod: person?.originMethod ?? null,
    audienceSegment: person?.audienceSegment ?? null,
    frozenCandidateAudienceSegment: claimed.audienceSegment ?? null,
    frozenCampaignAudienceSegment: campaign?.audienceSegment ?? null,
    approvedWesternOnly: campaign?.westernOnly ?? null,
    inboundCount,
    completedCount,
    priorRecoveryCount,
    sentThisHour,
    sentToday,
    sourceComment,
    sourceCommentId: sourceResolution.kind === "selected" ? sourceResolution.commentId : null,
  };
}
