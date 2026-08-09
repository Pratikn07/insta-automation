import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  finalizePublicRecoveryDispatch,
  releaseReservedPublicRecoveryDispatch,
  reservePublicRecoveryDispatch,
  startPublicRecoveryDispatch,
  type DispatchReservation,
} from "./publicRecoveryDispatchRepository.js";
import { resolveCanonicalConversation } from "./canonicalConversation.js";
import { evaluateHistoricalOrigin } from "./historicalRecoveryOriginPolicy.js";

/**
 * Claim and finalise historical recovery candidates.
 *
 * Deliberately mirrors dmRecoveryRepository's contracts — lease-based claims,
 * boolean returns on finalisation, no throwing — so the worker can drive both
 * kinds of send through one loop and historical sends inherit every safety fix
 * made to the prospective path.
 *
 * The candidate row is a frozen snapshot, so nothing here re-derives eligibility
 * from live data. The only live questions asked before a send are the ones that
 * could have CHANGED since selection, and those are asked in the worker.
 */

/** What the worker needs to post one public reply. */
export type ClaimedCandidate = {
  id: string;
  campaignId: string;
  igUserId: string;
  /** Needed by the final recheck to scope completion to THIS keyword (QA-11). */
  keywordId: string;
  /**
   * The source-data cutoff at which this candidate's evidence was frozen (QA-11).
   *
   * The recheck asks "has anything changed SINCE selection", and without this it asked
   * "has anything EVER happened" — so a reply or completion that predated the request
   * suppressed the candidate. `eligibleAt` is written from the campaign's frozen
   * `sourceDataCutoff`; unlike `createdAt`, it also covers evidence that arrives while
   * the selector is building and inserting the reviewed manifest.
   */
  selectedAt: Date;
  commentId: string;
  sources: Array<{ position: number; commentId: string }>;
  publicReplyText: string;
  keywordSnapshot: string;
  evidence: string;
  arm: string;
  audienceOrigin: string | null;
  /**
   * Proof this worker holds the row. Every release and finalise must present it, so a
   * stale claimant cannot overwrite the winner's outcome.
   */
  claimToken: string;
  attempts: number;
};

/**
 * Candidates due to send, oldest comment first.
 *
 * Only from a `running` campaign: a draft or paused campaign must never send, and
 * making that a query condition rather than a code check means a pause takes effect
 * on the next tick without needing the worker to notice.
 *
 * `holdout` rows are excluded here rather than filtered later — they are the
 * control arm and must never be claimed at all.
 */
export async function listDueCandidateIds(
  now: Date,
  limit: number,
  campaignId?: string,
): Promise<string[]> {
  const rows = await prisma.recoveryCandidate.findMany({
    where: {
      outcome: "pending",
      arm: "treatment",
      eligibleAt: { lte: now },
      campaign: { state: "running" },
      ...(campaignId ? { campaignId } : {}),
      // Skip rows another worker already holds, and rows waiting out a backoff after a
      // retryable failure. Without the backoff filter a rate-limited row was retried
      // on every tick forever.
      claimToken: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { commentAt: "asc" },
    // Over-fetch like the prospective path: a row suppressed during the claim must
    // not consume a send slot, so the caller applies the real cap.
    take: limit * 3,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Take a lease on one candidate.
 *
 * Conditional on `outcome: pending` so two workers cannot both claim it — the
 * update matches zero rows for the loser. Returns null rather than throwing, so a
 * lost race is an ordinary skip.
 */
export async function claimCandidate(
  id: string,
  now: Date,
  leaseUntil: Date,
): Promise<ClaimedCandidate | null> {
  const token = randomUUID();

  // Compare-and-set on `claimToken IS NULL`. The previous predicate matched only
  // (id, pending, treatment) and left the row pending, so a second concurrent call
  // matched the SAME row and overwrote the first lease — verified against real
  // Postgres: two claims, both succeeded, both would have posted publicly.
  //
  // Lease reconciliation is the only code allowed to retire an expired token. Letting
  // this update overwrite it meant the stale worker and replacement worker could both
  // reach authorization with different tokens for the same source.
  const claimed = await prisma.recoveryCandidate.updateMany({
    where: {
      id,
      outcome: "pending",
      arm: "treatment",
      claimToken: null,
    },
    data: {
      claimedAt: now,
      claimExpiresAt: leaseUntil,
      claimToken: token,
      attempts: { increment: 1 },
      lastAttemptAt: now,
    },
  });
  if (claimed.count === 0) return null;

  // Re-read filtered BY THE TOKEN. Reading by id alone could return a row a different
  // worker claimed in between, handing this caller someone else's candidate.
  const row = await prisma.recoveryCandidate.findFirst({
    where: { id, claimToken: token },
    select: {
      id: true,
      campaignId: true,
      igUserId: true,
      keywordId: true,
      eligibleAt: true,
      commentId: true,
      sources: {
        orderBy: { position: "asc" },
        select: { position: true, commentId: true },
      },
      publicReplyText: true,
      keywordSnapshot: true,
      evidence: true,
      arm: true,
      audienceOrigin: true,
      attempts: true,
    },
  });
  if (!row) return null;

  const { eligibleAt, ...rest } = row;
  return { ...rest, selectedAt: eligibleAt, claimToken: token };
}

export type HistoricalDispatchInput = {
  candidateId: string;
  claimToken: string;
  now: Date;
  hourlyCap: number;
  dailyCap: number;
  globalHourlyCap: number;
  globalDailyCap: number;
  prospectiveCooldownHours: number;
};

/** Final, token-fenced historical reservation under the shared lock order. */
export async function reserveHistoricalDispatch(
  input: HistoricalDispatchInput,
): Promise<DispatchReservation> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      select: { igUserId: true },
    });
    if (!sourceHint) return { kind: "blocked", reason: "stale_claim" };

    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${input.candidateId}::uuid FOR UPDATE`;

    const control = await tx.dmRecoveryControl.findUnique({ where: { id: 1 } });
    if (control?.circuitOpen) return { kind: "blocked", reason: "circuit_open" };

    const source = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      include: { campaign: { select: { state: true } } },
    });
    if (
      !source ||
      source.outcome !== "pending" ||
      source.arm !== "treatment" ||
      source.campaign.state !== "running" ||
      source.claimToken !== input.claimToken ||
      !source.claimExpiresAt ||
      source.claimExpiresAt <= input.now
    ) {
      return { kind: "blocked", reason: "stale_claim" };
    }
    if (source.conversationId) {
      const canonical = await resolveCanonicalConversation(tx, source.conversationId);
      if (
        !canonical ||
        canonical.role === "alias" ||
        canonical.canonicalIntentId !== source.intentId
      ) {
        return { kind: "blocked", reason: "reconciled_alias" };
      }
    }

    return reservePublicRecoveryDispatch(tx, {
      sourceKind: "historical",
      sourceId: source.id,
      attemptNumber: source.attempts,
      igUserId: source.igUserId,
      campaignId: source.campaignId,
      now: input.now,
      leaseExpiresAt: source.claimExpiresAt,
      prospectiveCooldownHours: input.prospectiveCooldownHours,
      globalHourlyCap: input.globalHourlyCap,
      globalDailyCap: input.globalDailyCap,
      campaignHourlyCap: input.hourlyCap,
      campaignDailyCap: input.dailyCap,
    });
  });
}

export async function startHistoricalDispatch(input: {
  candidateId: string;
  claimToken: string;
  batchRunId: string;
  dispatchId: string;
  reservationToken: string;
  commentId: string;
  /** Retained for caller compatibility; it cannot relax the current-Gemini gate. */
  currentWesternOnly?: boolean;
  now: Date;
}): Promise<StartHistoricalDispatchResult> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      select: { igUserId: true },
    });
    if (!sourceHint) return { kind: "blocked", reason: "stale_claim" };
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${input.candidateId}::uuid FOR UPDATE`;

    const control = await tx.dmRecoveryControl.findUnique({ where: { id: 1 } });
    if (control?.circuitOpen) return { kind: "blocked", reason: "circuit_open" };

    // Inbound persistence shares the control lock above. Therefore a committed inbound
    // safety-inbox row cannot appear between this check and dispatch start: either it
    // committed first and blocks here, or this dispatch is already explicitly in flight.
    const pendingHealthCapture = await tx.dmMessage.findFirst({
      where: {
        direction: "inbound",
        instagramMessageId: { not: null },
        campaignHealthCapturedAt: null,
      },
      select: { id: true },
    });
    if (pendingHealthCapture) {
      return { kind: "blocked", reason: "campaign_health_capture_pending" };
    }

    const source = await tx.recoveryCandidate.findUnique({ where: { id: input.candidateId } });
    if (
      !source ||
      source.outcome !== "pending" ||
      source.arm !== "treatment" ||
      source.claimToken !== input.claimToken ||
      !source.claimExpiresAt ||
      source.claimExpiresAt <= input.now
    ) {
      return { kind: "blocked", reason: "stale_claim" };
    }

    // The advisory recheck happens before reservation. Re-read its most important
    // person-level fact under the same control/person locks as final authorization.
    // recordInboundMessage also takes the control lock, so no inbound can commit
    // between this query and the dispatch-start transition. Captured rows count too:
    // capture means classification finished, not that the recovery premise survived.
    const inboundSinceSelection = await tx.dmMessage.findFirst({
      where: {
        thread: { igUserId: source.igUserId },
        direction: "inbound",
        createdAt: { gte: source.eligibleAt },
      },
      select: { id: true },
    });
    if (inboundSinceSelection) {
      return { kind: "blocked", reason: "inbound_since_selection" };
    }

    const approvedSource = await tx.recoveryCandidateSource.findUnique({
      where: {
        candidateId_commentId: {
          candidateId: source.id,
          commentId: input.commentId,
        },
      },
      select: { id: true },
    });
    if (!approvedSource) {
      return { kind: "blocked", reason: "source_not_approved" };
    }

    await tx.$queryRaw`SELECT "id" FROM "recovery_campaign" WHERE "id" = ${source.campaignId}::uuid FOR UPDATE`;
    const campaign = await tx.recoveryCampaign.findUnique({
      where: { id: source.campaignId },
      select: { state: true, westernOnly: true },
    });
    if (campaign?.state !== "running") {
      return { kind: "blocked", reason: "campaign_not_running" };
    }
    if (campaign.westernOnly === null) {
      return { kind: "blocked", reason: "campaign_policy_incomplete" };
    }

    // Keyword edits and origin enrichment take ordinary row locks. Taking the same
    // locks before these reads makes the final decision linearizable: an earlier update
    // is visible here, while a later one waits until dispatch has been explicitly
    // stamped as started.
    await tx.$queryRaw`SELECT "id" FROM "keywords" WHERE "id" = ${source.keywordId}::uuid FOR UPDATE`;
    const [person, keyword] = await Promise.all([
      tx.igUser.findUnique({
        where: { id: source.igUserId },
        select: { inferredOrigin: true, originConfidence: true, originMethod: true },
      }),
      tx.keyword.findUnique({
        where: { id: source.keywordId },
        select: { active: true },
      }),
    ]);
    const suppressBeforeStart = async (
      reason: HistoricalDispatchStartSuppressionReason,
    ): Promise<StartHistoricalDispatchResult> => {
      const released = await releaseReservedPublicRecoveryDispatch(tx, {
        dispatchId: input.dispatchId,
        reservationToken: input.reservationToken,
        at: input.now,
        reason: `dispatch_start_suppressed:${reason}`,
      });
      if (!released) return { kind: "blocked", reason: "reservation_not_active" };
      const suppressed = await tx.recoveryCandidate.updateMany({
        where: {
          id: source.id,
          outcome: "pending",
          claimToken: input.claimToken,
          dispatchStartedAt: null,
        },
        data: {
          outcome: "suppressed",
          suppressionReason: reason,
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
        },
      });
      if (suppressed.count !== 1) {
        throw new Error("historical_dispatch_final_suppression_failed");
      }
      return { kind: "suppressed", reason };
    };
    const deferBeforeStart = async (
      reason: HistoricalDispatchStartDeferReason,
    ): Promise<StartHistoricalDispatchResult> => {
      const released = await releaseReservedPublicRecoveryDispatch(tx, {
        dispatchId: input.dispatchId,
        reservationToken: input.reservationToken,
        at: input.now,
        reason: `dispatch_start_deferred:${reason}`,
      });
      if (!released) return { kind: "blocked", reason: "reservation_not_active" };
      const deferred = await tx.recoveryCandidate.updateMany({
        where: {
          id: source.id,
          outcome: "pending",
          claimToken: input.claimToken,
          dispatchStartedAt: null,
        },
        data: {
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
          nextAttemptAt: null,
        },
      });
      if (deferred.count !== 1) {
        throw new Error("historical_dispatch_final_deferral_failed");
      }
      return { kind: "deferred", reason };
    };
    if (!keyword?.active) return suppressBeforeStart("keyword_inactive");

    await tx.$queryRaw`
      SELECT "id" FROM "recovery_campaign_batch_run" WHERE "id" = ${input.batchRunId}::uuid FOR UPDATE
    `;
    const batch = await tx.recoveryCampaignBatchRun.findUnique({
      where: { id: input.batchRunId },
      select: {
        campaignId: true,
        tickToken: true,
        allowance: true,
        consumed: true,
        status: true,
        leaseExpiresAt: true,
      },
    });
    if (
      !control?.historicalTickToken ||
      !control.historicalTickExpiresAt ||
      control.historicalTickExpiresAt <= input.now ||
      !batch ||
      batch.campaignId !== source.campaignId ||
      batch.tickToken !== control.historicalTickToken ||
      batch.status !== "active" ||
      batch.leaseExpiresAt <= input.now
    ) {
      return { kind: "blocked", reason: "batch_not_active" };
    }
    if (batch.consumed >= batch.allowance) {
      return { kind: "blocked", reason: "campaign_batch_exhausted" };
    }

    // The person row was locked with the control/candidate locks above, so this is the
    // linearization point for origin enrichment: a committed rewrite is visible here;
    // a later rewrite waits until dispatch has been explicitly marked started. This
    // mandatory gate is deliberately immediately before the dispatch-start transition.
    const originDecision = evaluateHistoricalOrigin({
      origin: person?.inferredOrigin ?? null,
      confidence: person?.originConfidence ?? null,
      method: person?.originMethod ?? null,
    });
    if (originDecision.kind === "stale") return deferBeforeStart(originDecision.reason);
    if (originDecision.kind === "block") return suppressBeforeStart(originDecision.reason);

    const started = await startPublicRecoveryDispatch(tx, input);
    if (!started) return { kind: "blocked", reason: "reservation_not_active" };
    const consumed = await tx.recoveryCampaignBatchRun.updateMany({
      where: {
        id: input.batchRunId,
        status: "active",
        consumed: { lt: batch.allowance },
        leaseExpiresAt: { gt: input.now },
      },
      data: { consumed: { increment: 1 } },
    });
    if (consumed.count !== 1) {
      throw new Error("historical_campaign_batch_consume_failed");
    }
    const stamped = await tx.recoveryCandidate.updateMany({
      where: { id: input.candidateId, outcome: "pending", claimToken: input.claimToken },
      data: {
        dispatchStartedAt: input.now,
        dispatchCommentId: input.commentId,
        lastAttemptAt: input.now,
      },
    });
    if (stamped.count !== 1) {
      throw new Error("historical_dispatch_source_stamp_failed");
    }
    return { kind: "started" };
  });
}

export type HistoricalDispatchStartBlockReason =
  | "stale_claim"
  | "campaign_not_running"
  | "circuit_open"
  | "campaign_health_capture_pending"
  | "inbound_since_selection"
  | "source_not_approved"
  | "campaign_policy_incomplete"
  | "batch_not_active"
  | "campaign_batch_exhausted"
  | "reservation_not_active";

export type HistoricalDispatchStartSuppressionReason =
  | "audience_south_asian"
  | "audience_unknown"
  | "audience_other"
  | "keyword_inactive";

export type HistoricalDispatchStartDeferReason = "origin_not_current_gemini";

export type StartHistoricalDispatchResult =
  | { kind: "started" }
  | { kind: "suppressed"; reason: HistoricalDispatchStartSuppressionReason }
  | { kind: "deferred"; reason: HistoricalDispatchStartDeferReason }
  | { kind: "blocked"; reason: HistoricalDispatchStartBlockReason };

export async function releaseHistoricalReservation(input: {
  candidateId: string;
  claimToken: string;
  dispatchId: string;
  reservationToken: string;
  at: Date;
  reason: string;
  nextAttemptAt?: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      select: { igUserId: true },
    });
    if (!sourceHint) return false;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${input.candidateId}::uuid FOR UPDATE`;

    const released = await releaseReservedPublicRecoveryDispatch(tx, input);
    if (!released) return false;

    await tx.recoveryCandidate.updateMany({
      where: {
        id: input.candidateId,
        outcome: "pending",
        claimToken: input.claimToken,
        dispatchStartedAt: null,
      },
      data: {
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
        nextAttemptAt: input.nextAttemptAt,
      },
    });
    return true;
  });
}

export async function finalizeHistoricalDispatch(input: {
  candidateId: string;
  claimToken: string;
  dispatchId: string;
  reservationToken: string;
  outcome:
    | { kind: "sent"; at: Date; providerReplyId: string }
    | { kind: "uncertain"; reason: string }
    | { kind: "released"; at: Date; reason: string; nextAttemptAt?: Date }
    | { kind: "failed"; at: Date; reason: string };
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.recoveryCandidate.findUnique({
      where: { id: input.candidateId },
      select: { igUserId: true },
    });
    if (!sourceHint) return false;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${input.candidateId}::uuid FOR UPDATE`;

    const source = await tx.recoveryCandidate.findUnique({ where: { id: input.candidateId } });
    if (!source || source.outcome !== "pending" || source.claimToken !== input.claimToken) {
      return false;
    }

    const ledgerOutcome =
      input.outcome.kind === "failed"
        ? {
            kind: "released" as const,
            dispatchId: input.dispatchId,
            reservationToken: input.reservationToken,
            at: input.outcome.at,
            reason: input.outcome.reason,
          }
        : { ...input.outcome, dispatchId: input.dispatchId, reservationToken: input.reservationToken };
    if (!(await finalizePublicRecoveryDispatch(tx, ledgerOutcome))) return false;

    const common = { claimedAt: null, claimExpiresAt: null, claimToken: null };
    const result = await tx.recoveryCandidate.updateMany({
      where: { id: input.candidateId, outcome: "pending", claimToken: input.claimToken },
      data:
        input.outcome.kind === "sent"
          ? {
              ...common,
              outcome: "sent",
              sentAt: input.outcome.at,
              publicReplyId: input.outcome.providerReplyId,
            }
          : input.outcome.kind === "uncertain"
            ? { ...common, outcome: "send_uncertain", suppressionReason: input.outcome.reason }
            : input.outcome.kind === "failed"
              ? { ...common, outcome: "send_failed", suppressionReason: input.outcome.reason }
              : {
                  ...common,
                  dispatchStartedAt: null,
                  nextAttemptAt: input.outcome.nextAttemptAt,
                },
    });
    return result.count === 1;
  });
}

/**
 * Reconcile leases that expired mid-send.
 *
 * A lease that ran out means the process died holding a claim. What that MEANS depends
 * on whether dispatch had started (QA-10):
 *
 *   - `dispatchStartedAt` set  → Meta may have been called, so the comment may exist.
 *     Terminal `send_uncertain`, never retried: a retry risks a second public comment.
 *   - `dispatchStartedAt` null → the process died while preparing. Meta was never
 *     called, so the row is released for a later tick.
 *
 * Every expired lease previously became `send_uncertain`, so a worker that died during a
 * database read — or was simply restarted mid-tick — permanently burned a candidate and
 * recorded it as "we may have posted".
 *
 * Returns the count parked as uncertain; released rows are reported separately.
 */
export async function reconcileExpiredCandidateLeases(
  now: Date,
): Promise<{ uncertain: number; released: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    const rows = await tx.recoveryCandidate.findMany({
      where: {
        outcome: "pending",
        claimToken: { not: null },
        claimExpiresAt: { lte: now },
      },
      orderBy: [{ igUserId: "asc" }, { id: "asc" }],
    });
    let uncertain = 0;
    let released = 0;

    for (const row of rows) {
      await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${row.igUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "recovery_candidate" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const ledger = await tx.publicRecoveryDispatch.findFirst({
        where: {
          sourceKind: "historical",
          sourceId: row.id,
          attemptNumber: row.attempts,
          state: { in: ["reserved", "dispatch_started"] },
        },
      });
      const mayHaveDispatched =
        ledger?.state === "dispatch_started" || row.dispatchStartedAt !== null;

      if (ledger) {
        await finalizePublicRecoveryDispatch(
          tx,
          mayHaveDispatched
            ? {
                kind: "uncertain",
                dispatchId: ledger.id,
                reservationToken: ledger.reservationToken,
                reason: "dispatch_lease_expired",
              }
            : {
                kind: "released",
                dispatchId: ledger.id,
                reservationToken: ledger.reservationToken,
                at: now,
                reason: "dispatch_lease_expired",
              },
        );
      }

      const updated = await tx.recoveryCandidate.updateMany({
        where: { id: row.id, outcome: "pending", claimToken: row.claimToken },
        data: mayHaveDispatched
          ? {
              outcome: "send_uncertain",
              suppressionReason: "dispatch_lease_expired",
              claimedAt: null,
              claimExpiresAt: null,
              claimToken: null,
            }
          : {
              claimedAt: null,
              claimExpiresAt: null,
              claimToken: null,
              nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000),
            },
      });
      if (updated.count === 1) {
        if (mayHaveDispatched) uncertain++;
        else released++;
      }
    }
    return { uncertain, released };
  });
}

/**
 * Release a claim so the row can be re-evaluated on a later tick.
 *
 * `nextAttemptAt` defers a retryable failure. Without it a rate-limited row was
 * retried on every tick forever, because releasing the claim left no trace.
 *
 * `dispatchStartedAt` is cleared as part of handing the row back, and it has to be.
 * `chk_candidate_dispatch_needs_claim` requires a pending row with a dispatch stamp to
 * hold a claim token, so dropping the token while leaving the stamp raised a check
 * violation — the release THREW, the exception escaped to the tick's outer catch, and the
 * whole tick aborted with the row still claimed. Lease reconciliation then read the stale
 * stamp as "Meta may have been called" and parked the row `send_uncertain`: terminal,
 * never retried, counted against the cap, and reported to the operator as a public
 * comment that might exist.
 *
 * Clearing it is correct, not just constraint-appeasing. Release is only reachable before
 * a ledger reservation or after a proven-safe ledger release. Every path where a comment
 * may exist goes through `finalizeHistoricalDispatch` and keeps its dispatch audit trail.
 */
export async function releaseCandidateClaim(
  id: string,
  claimToken: string,
  nextAttemptAt?: Date,
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, claimToken },
    data: {
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
      dispatchStartedAt: null,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    },
  });
  return count === 1;
}

/**
 * Suppress a candidate the pre-send recheck rejected.
 *
 * Terminal: the reason it failed (deleted comment, person replied, market rule) is
 * not the kind of thing that reverses, and re-checking it every tick would be
 * pointless load.
 */
export async function markCandidateSuppressed(
  id: string,
  claimToken: string,
  reason: string,
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending", claimToken },
    data: {
      outcome: "suppressed",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
  return count === 1;
}

export async function markCandidateFailed(
  id: string,
  claimToken: string,
  reason: string,
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending", claimToken },
    data: {
      outcome: "send_failed",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
  return count === 1;
}

/**
 * The send may have landed. Parked for a human, never retried.
 *
 * `reviewedAt` stays null so the dashboard can surface it as needing attention.
 */
/**
 * How much shared-ledger capacity this campaign has consumed since `since`.
 * This is advisory data for the early recheck; the reservation transaction repeats the
 * same decision under locks. Released work consumes no capacity, while reservations,
 * started work, confirmed sends, and uncertain sends all do.
 */
export async function countCandidatesSentSince(campaignId: string, since: Date): Promise<number> {
  return prisma.publicRecoveryDispatch.count({
    where: {
      campaignId,
      state: { in: ["reserved", "dispatch_started", "sent", "uncertain"] },
      reservedAt: { gt: since },
    },
  });
}
