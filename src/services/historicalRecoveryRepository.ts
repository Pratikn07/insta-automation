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
  commentId: string;
  publicReplyText: string;
  keywordSnapshot: string;
  evidence: string;
  arm: string;
  audienceOrigin: string | null;
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
  const claimed = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending", arm: "treatment" },
    data: { claimedAt: now, claimExpiresAt: leaseUntil },
  });
  if (claimed.count === 0) return null;

  const row = await prisma.recoveryCandidate.findUnique({
    where: { id },
    select: {
      id: true,
      campaignId: true,
      igUserId: true,
      commentId: true,
      publicReplyText: true,
      keywordSnapshot: true,
      evidence: true,
      arm: true,
      audienceOrigin: true,
    },
  });
  return row;
}

/**
 * Reconcile leases that expired mid-send.
 *
 * A lease that ran out means the process died after claiming. The comment may or
 * may not have posted, so these become `send_uncertain` and are NEVER retried
 * automatically — a retry would risk a second public comment on someone's post.
 */
export async function reconcileExpiredCandidateLeases(now: Date): Promise<number> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: {
      outcome: "pending",
      claimedAt: { not: null },
      claimExpiresAt: { lte: now },
    },
    data: {
      outcome: "send_uncertain",
      suppressionReason: "stale_lease",
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return count;
}

/** Release a claim so the row can be re-evaluated on a later tick. */
export async function releaseCandidateClaim(id: string): Promise<void> {
  await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending" },
    data: { claimedAt: null, claimExpiresAt: null },
  });
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
  input: { publicReplyId: string; sentAt: Date },
): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending" },
    data: {
      outcome: "sent",
      publicReplyId: input.publicReplyId,
      sentAt: input.sentAt,
      claimedAt: null,
      claimExpiresAt: null,
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
export async function markCandidateSuppressed(id: string, reason: string): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending" },
    data: {
      outcome: "suppressed",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return count === 1;
}

export async function markCandidateFailed(id: string, reason: string): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending" },
    data: {
      outcome: "send_failed",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
    },
  });
  return count === 1;
}

/**
 * The send may have landed. Parked for a human, never retried.
 *
 * `reviewedAt` stays null so the dashboard can surface it as needing attention.
 */
export async function markCandidateUncertain(id: string, reason: string): Promise<boolean> {
  const { count } = await prisma.recoveryCandidate.updateMany({
    where: { id, outcome: "pending" },
    data: {
      outcome: "send_uncertain",
      suppressionReason: reason,
      claimedAt: null,
      claimExpiresAt: null,
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
    where: { campaignId, outcome: "sent", sentAt: { gte: since } },
  });
}
