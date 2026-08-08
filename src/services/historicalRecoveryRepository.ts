import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";

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
   * When this candidate was selected, i.e. the moment its evidence was frozen (QA-11).
   *
   * The recheck asks "has anything changed SINCE selection", and without this it asked
   * "has anything EVER happened" — so a reply or completion that predated the request
   * suppressed the candidate. `createdAt` is the selection moment: the selector writes
   * the row and never updates it.
   */
  selectedAt: Date;
  commentId: string;
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
export async function listDueCandidateIds(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.recoveryCandidate.findMany({
    where: {
      outcome: "pending",
      arm: "treatment",
      eligibleAt: { lte: now },
      campaign: { state: "running" },
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
  // An expired lease is reclaimable: `reconcileExpiredCandidateLeases` normally moves
  // those to send_uncertain first, but a row whose lease lapsed between that sweep and
  // this call must not be stranded.
  const claimed = await prisma.recoveryCandidate.updateMany({
    where: {
      id,
      outcome: "pending",
      arm: "treatment",
      OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
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
      createdAt: true,
      commentId: true,
      publicReplyText: true,
      keywordSnapshot: true,
      evidence: true,
      arm: true,
      audienceOrigin: true,
      attempts: true,
    },
  });
  if (!row) return null;

  const { createdAt, ...rest } = row;
  return { ...rest, selectedAt: createdAt, claimToken: token };
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
  const expired = {
    outcome: "pending" as const,
    claimedAt: { not: null },
    claimExpiresAt: { lte: now },
  };

  const [uncertain, released] = await prisma.$transaction([
    prisma.recoveryCandidate.updateMany({
      where: { ...expired, dispatchStartedAt: { not: null } },
      data: {
        outcome: "send_uncertain",
        suppressionReason: "stale_lease",
        claimedAt: null,
        claimExpiresAt: null,
        // Must be cleared, or the partial unique index keeps the row claimed forever.
        claimToken: null,
      },
    }),
    prisma.recoveryCandidate.updateMany({
      where: { ...expired, dispatchStartedAt: null },
      data: {
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
        // Backed off so a repeatedly-dying worker does not spin on the same row.
        nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000),
      },
    }),
  ]);

  return { uncertain: uncertain.count, released: released.count };
}

/**
 * Release a claim so the row can be re-evaluated on a later tick.
 *
 * `nextAttemptAt` defers a retryable failure. Without it a rate-limited row was
 * retried on every tick forever, because releasing the claim left no trace.
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
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    },
  });
  return count === 1;
}

/**
 * Record a confirmed send.
 *
 * `publicReplyId` is required by chk_candidate_sent_has_reply_id: without Meta's
 * id there is no evidence the comment posted, and this feature posts publicly under
 * the account's own name. Returns false if the row moved underneath us.
 */
export async function markCandidateSent(
  id: string,
  claimToken: string,
  input: { publicReplyId: string; sentAt: Date },
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    // Token required: a stale claimant must not be able to finalise the winner's row.
    where: { id, outcome: "pending", claimToken },
    data: {
      outcome: "sent",
      publicReplyId: input.publicReplyId,
      sentAt: input.sentAt,
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
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
export async function markCandidateUncertain(
  id: string,
  claimToken: string,
  reason: string,
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending", claimToken },
    data: {
      outcome: "send_uncertain",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
  return count === 1;
}

/**
 * How many public recoveries this campaign has sent in the trailing hour.
 *
 * Counted from `sentAt` on confirmed sends only, so a failed attempt does not
 * consume the cap — but an uncertain one is NOT counted either, which is a
 * deliberate under-count: an uncertain row may have posted, so treating it as sent
 * would be safer. Left as-is because the hourly cap is a rate limit, not a safety
 * boundary, and the per-person guards are what prevent double contact.
 */
export async function countCandidatesSentSince(campaignId: string, since: Date): Promise<number> {
  return prisma.recoveryCandidate.count({
    where: {
      campaignId,
      // `send_uncertain` counts. The comment may be live on Instagram, so excluding it
      // let an unknown number of real public comments escape the cap (QA-08).
      // Same definition the reservation uses, so the advisory count in the recheck and
      // the authoritative count under the lock cannot disagree.
      ...consumedSince(since),
    },
  });
}

/**
 * Reserve one send slot against the campaign's caps AND the shared global cap (QA-08).
 *
 * The worker previously read the hour and day counts, then posted, with nothing holding
 * the gap. Two workers could each read "2 of 3 this hour" and both post, and the
 * historical caps were per-campaign only — so two running campaigns, or historical plus
 * prospective, could each stay inside their own limit while the account posted far more
 * public comments than any single number suggested.
 *
 * `dm_recovery_control` row 1 is locked FOR UPDATE, which is the same row and the same
 * lock the prospective path already takes. That makes the two systems serialise against
 * each other rather than merely counting each other.
 *
 * `send_uncertain` and in-flight claims consume capacity: an uncertain post may be live
 * on Instagram, so excluding it would let real comments escape the cap. The caller's own
 * claim is excluded by id, because it would otherwise count itself.
 *
 * Returns the reason a slot was refused, or null when the send may proceed.
 */
export async function reserveSendCapacity(input: {
  candidateId: string;
  campaignId: string;
  now: Date;
  hourlyCap: number;
  dailyCap: number;
  globalHourlyCap: number;
}): Promise<null | "hourly_cap_reached" | "daily_cap_reached" | "global_hourly_cap_reached"> {
  const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    // The serialisation point, shared with the prospective worker.
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;

    const [thisHour, today, prospectiveThisHour] = await Promise.all([
      tx.recoveryCandidate.count({
        where: { campaignId: input.campaignId, id: { not: input.candidateId }, ...consumedSince(hourAgo) },
      }),
      tx.recoveryCandidate.count({
        where: { campaignId: input.campaignId, id: { not: input.candidateId }, ...consumedSince(dayAgo) },
      }),
      // Global: EVERY historical campaign plus the prospective feature. One account
      // posts all of these under one name, so the ceiling has to be one number.
      Promise.all([
        tx.recoveryCandidate.count({
          where: { id: { not: input.candidateId }, ...consumedSince(hourAgo) },
        }),
        tx.dmRecoveryReminder.count({
          where: {
            OR: [
              { sentAt: { gte: hourAgo } },
              { lastAttemptAt: { gte: hourAgo }, status: { in: ["sending", "send_uncertain"] } },
            ],
          },
        }),
      ]).then(([historical, prospective]) => historical + prospective),
    ]);

    if (today >= input.dailyCap) return "daily_cap_reached";
    if (thisHour >= input.hourlyCap) return "hourly_cap_reached";
    if (prospectiveThisHour >= input.globalHourlyCap) return "global_hourly_cap_reached";

    // Stamping dispatchStartedAt inside the lock is what makes the reservation real: the
    // next worker's count sees this row as in-flight and cannot reuse the slot. It also
    // marks the point after which a failure may mean a comment exists — before this, a
    // claimed row is provably pre-network and safe to release (QA-10).
    await tx.recoveryCandidate.updateMany({
      where: { id: input.candidateId },
      data: { dispatchStartedAt: input.now, lastAttemptAt: input.now },
    });

    return null;
  });
}

/**
 * Rows that have consumed a send slot since `since`.
 *
 * Keyed on `dispatchStartedAt`, NOT on holding a claim. A claim means "a worker is
 * preparing this row"; only dispatch means "a public comment may exist". Counting claims
 * deadlocked the cap: two workers each holding a claim counted the other as in-flight, so
 * with a cap of 1 neither could reserve the last slot and the campaign stalled — verified
 * against real Postgres before this fix.
 *
 * `send_uncertain` is included even without a dispatch timestamp, because a row parked by
 * lease reconciliation may have posted before the process died.
 */
function consumedSince(since: Date) {
  return {
    OR: [
      { outcome: "sent" as const, sentAt: { gte: since } },
      { outcome: "send_uncertain" as const, lastAttemptAt: { gte: since } },
      { outcome: "pending" as const, dispatchStartedAt: { gte: since } },
    ],
  };
}
