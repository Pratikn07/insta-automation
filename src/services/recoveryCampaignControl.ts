import { prisma } from "../lib/prisma.js";
import { logEvent } from "./eventLogger.js";
import {
  verifyStoredSelectionSnapshot,
  type SelectionSnapshotConfiguration,
  type SelectionSnapshotInclusion,
} from "./historicalRecoverySnapshot.js";

/**
 * Owner control over a historical recovery campaign.
 *
 * The design (§40) is explicit that there is no per-row "send now": the owner's
 * levers are approve, pause, and cancel on the whole campaign. That keeps the
 * decision at the level the owner can actually reason about — "start contacting
 * these 985 people" — rather than 985 individual choices.
 *
 * Every transition is conditional on the current state, so a double-click cannot
 * approve twice and a pause cannot resurrect a cancelled campaign.
 */

export type CampaignTransition =
  | {
      ok: true;
      state: string;
      cancelledCandidates?: number;
      inFlightCandidates?: number;
    }
  | { ok: false; reason: string };

/**
 * Approve a campaign and start sending.
 *
 * This is the moment selection is frozen and public comments become possible, so it
 * records WHO approved and when — `chk_campaign_approval_complete` requires both,
 * and `chk_campaign_running_is_approved` is what makes "running implies approved"
 * true at the database level rather than merely in this function.
 *
 * Only from `draft` or `awaiting_approval`. A campaign cannot be re-approved to
 * reset its state, because its candidates may already have been sent.
 */
export async function approveCampaign(
  campaignId: string,
  approvedBy: string,
  now = new Date(),
): Promise<CampaignTransition> {
  if (!approvedBy.trim()) {
    return { ok: false, reason: "approver_required" };
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    // Lock the campaign before scanning any manifest child. Source mutation uses the
    // same parent lock, so an insert cannot become visible after verification but before
    // this transaction seals the reviewed campaign.
    await tx.$queryRaw`
      SELECT "id" FROM "recovery_campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT u."id"
      FROM "ig_users" u
      JOIN "recovery_candidate" c ON c."ig_user_id" = u."id"
      WHERE c."campaign_id" = ${campaignId}::uuid
      ORDER BY u."id"
      FOR UPDATE OF u
    `;
    await tx.$queryRaw`
      SELECT c."id"
      FROM "recovery_candidate" c
      WHERE c."campaign_id" = ${campaignId}::uuid
      ORDER BY c."ig_user_id", c."id"
      FOR UPDATE OF c
    `;
    await tx.$queryRaw`
      SELECT s."id"
      FROM "recovery_candidate_source" s
      JOIN "recovery_candidate" c ON c."id" = s."candidate_id"
      WHERE c."campaign_id" = ${campaignId}::uuid
      ORDER BY c."ig_user_id", c."id", s."position"
      FOR UPDATE OF s
    `;
    await tx.$queryRaw`
      SELECT e."id"
      FROM "recovery_selection_exclusion" e
      WHERE e."campaign_id" = ${campaignId}::uuid
      ORDER BY e."intent_id"
      FOR UPDATE OF e
    `;
    const current = await tx.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: {
        state: true,
        phase: true,
        selectionVersion: true,
        sourceDataCutoff: true,
        commentFrom: true,
        commentTo: true,
        holdoutPercent: true,
        copyVersion: true,
        selectionFingerprint: true,
        eligibilityPolicyVersion: true,
        westernOnly: true,
        inboundWindowHours: true,
        completionWindowHours: true,
        candidateCount: true,
        excludedCount: true,
        decisionHash: true,
      },
    });
    if (!current) return { kind: "blocked", reason: "not_found" } as const;
    if (!(["draft", "awaiting_approval"] as string[]).includes(current.state)) {
      return {
        kind: "blocked",
        reason: `not_approvable_from_${current.state}`,
      } as const;
    }

    const storedCandidates = await tx.recoveryCandidate.findMany({
      where: { campaignId },
      orderBy: [{ selectionPosition: "asc" }, { id: "asc" }],
      select: {
        selectionPosition: true,
        intentId: true,
        igUserId: true,
        conversationId: true,
        keywordId: true,
        commentId: true,
        mediaId: true,
        commentAt: true,
        keywordSnapshot: true,
        publicReplyText: true,
        evidence: true,
        audienceOrigin: true,
        audienceOriginConfidence: true,
        arm: true,
        sourceChoiceReason: true,
        sources: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: {
            position: true,
            commentId: true,
            mediaId: true,
            receivedAt: true,
            choiceReason: true,
          },
        },
      },
    });
    const storedExclusions = await tx.recoverySelectionExclusion.findMany({
      where: { campaignId },
      orderBy: [{ intentId: "asc" }, { id: "asc" }],
      select: { intentId: true, igUserId: true, keywordId: true, reason: true },
    });
    const configuration: SelectionSnapshotConfiguration | null =
      current.eligibilityPolicyVersion && current.westernOnly !== null
        ? {
            phase: current.phase,
            selectionVersion: current.selectionVersion,
            sourceDataCutoff: current.sourceDataCutoff.toISOString(),
            commentFrom: current.commentFrom?.toISOString() ?? null,
            commentTo: current.commentTo?.toISOString() ?? null,
            westernOnly: current.westernOnly,
            holdoutPercent: current.holdoutPercent,
            copyVersion: current.copyVersion,
            eligibilityPolicyVersion: current.eligibilityPolicyVersion,
            inboundWindowHours: current.inboundWindowHours,
            completionWindowHours: current.completionWindowHours,
          }
        : null;
    const inclusions: SelectionSnapshotInclusion[] = storedCandidates.map((candidate) => ({
      position: candidate.selectionPosition ?? -1,
      intentId: candidate.intentId,
      igUserId: candidate.igUserId,
      conversationId: candidate.conversationId,
      keywordId: candidate.keywordId,
      commentId: candidate.commentId,
      mediaId: candidate.mediaId,
      commentAt: candidate.commentAt.toISOString(),
      keywordSnapshot: candidate.keywordSnapshot,
      publicReplyText: candidate.publicReplyText,
      evidence: candidate.evidence,
      audienceOrigin: candidate.audienceOrigin,
      audienceOriginConfidence: candidate.audienceOriginConfidence,
      arm: candidate.arm,
      sourceChoiceReason: candidate.sourceChoiceReason ?? "",
      sources: candidate.sources.map((source) => ({
        position: source.position,
        commentId: source.commentId,
        mediaId: source.mediaId,
        receivedAt: source.receivedAt.toISOString(),
        choiceReason: source.choiceReason,
      })),
    }));
    const verified = verifyStoredSelectionSnapshot({
      configuration,
      selectionFingerprint: current.selectionFingerprint,
      decisionHash: current.decisionHash,
      candidateCount: current.candidateCount,
      excludedCount: current.excludedCount,
      inclusions,
      exclusions: storedExclusions,
    });
    if (!verified.ok) {
      return { kind: "blocked", reason: verified.reason } as const;
    }

    const withheld = await tx.recoveryCandidate.updateMany({
      where: { campaignId, arm: "holdout", outcome: "pending" },
      data: { outcome: "holdout_withheld", suppressionReason: "holdout_arm" },
    });
    const treatmentPending = await tx.recoveryCandidate.count({
      where: { campaignId, arm: "treatment", outcome: "pending" },
    });
    const state = treatmentPending === 0 ? "completed" : "running";
    await tx.recoveryCampaign.update({
      where: { id: campaignId },
      data: {
        state,
        approvedBy,
        approvedAt: now,
        startedAt: now,
        endedAt: state === "completed" ? now : null,
      },
    });
    return { kind: "moved", state, holdoutWithheld: withheld.count } as const;
  });

  if (result.kind === "blocked") return { ok: false, reason: result.reason };
  await logEvent("historical_campaign_approved", {
    campaignId,
    approvedBy,
    holdoutWithheld: result.holdoutWithheld,
  });
  return { ok: true, state: result.state };
}

/**
 * Pause a running campaign — the emergency stop.
 *
 * Takes effect on the next tick, and also mid-tick: the pre-send recheck reads
 * campaign state for every row, so a row already claimed when the pause lands is
 * released rather than sent. Pending candidates are left untouched so the campaign
 * can resume without re-selecting.
 */
export async function pauseCampaign(
  campaignId: string,
  reason: string,
  now = new Date(),
): Promise<CampaignTransition> {
  const { count } = await prisma.recoveryCampaign.updateMany({
    where: { id: campaignId, state: "running" },
    data: { state: "paused", pausedAt: now, pauseReason: reason },
  });

  if (count === 0) {
    const current = await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    return { ok: false, reason: current ? `not_pausable_from_${current.state}` : "not_found" };
  }

  await logEvent("historical_campaign_paused", { campaignId, reason });
  return { ok: true, state: "paused" };
}

/**
 * Resume a paused campaign. Approval is already recorded, so it is not re-asked.
 *
 * An AUTOMATIC pause latches (QA-13). A campaign stopped by a health signal — a failure
 * rate, unexplained uncertainty, a decayed cohort, a duplicate public reply — must not be
 * resumable by the same call that undoes an ordinary owner pause. Otherwise the stop is a
 * suggestion: a resume click, or a script looping over paused campaigns, silently
 * restarts sending into whatever went wrong.
 *
 * `acknowledgeAutoPause` is that gate. The caller must name what it is overriding, which
 * is what makes the resume a decision with an owner rather than a default.
 */
export async function resumeCampaign(
  campaignId: string,
  options: { acknowledgeAutoPause?: string } = {},
): Promise<CampaignTransition> {
  const current = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { state: true, pauseReason: true },
  });
  if (!current) return { ok: false, reason: "not_found" };
  if (current.state !== "paused") return { ok: false, reason: `not_resumable_from_${current.state}` };

  const autoPaused = current.pauseReason?.startsWith("auto:") ?? false;
  if (autoPaused && !options.acknowledgeAutoPause?.trim()) {
    // Reports the reason so the caller can show the owner WHAT they are overriding.
    return { ok: false, reason: `auto_pause_requires_review:${current.pauseReason}` };
  }

  const { count } = await prisma.recoveryCampaign.updateMany({
    // `approvedAt` must already be set — a paused campaign always has it, but the
    // condition makes the invariant explicit rather than assumed. Re-checking `paused`
    // closes the gap between the read above and this write.
    where: { id: campaignId, state: "paused", approvedAt: { not: null } },
    data: { state: "running", pausedAt: null, pauseReason: null },
  });

  if (count === 0) {
    const now = await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    return { ok: false, reason: now ? `not_resumable_from_${now.state}` : "not_found" };
  }

  await logEvent("historical_campaign_resumed", {
    campaignId,
    // The audit trail for overriding an automatic stop.
    overrodeAutoPause: autoPaused ? current.pauseReason : null,
    acknowledgedBy: autoPaused ? (options.acknowledgeAutoPause ?? null) : null,
  });
  return { ok: true, state: "running" };
}

/**
 * Cancel a campaign and abandon everything unsent.
 *
 * Terminal. Already-sent candidates keep their `sent` outcome and their reply ids —
 * those comments are live on Instagram and pretending otherwise would make the
 * record wrong. Only `pending` rows are cancelled.
 */
export async function cancelCampaign(
  campaignId: string,
  reason: string,
  now = new Date(),
): Promise<CampaignTransition> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;

    // Match the dispatch lock order in set form: control, people, candidate sources,
    // then campaign. Ordering makes cancellation deterministic even for a large cohort.
    await tx.$queryRaw`
      SELECT u."id"
      FROM "ig_users" u
      JOIN "recovery_candidate" c ON c."ig_user_id" = u."id"
      WHERE c."campaign_id" = ${campaignId}::uuid
        AND c."outcome" = 'pending'
      ORDER BY u."id"
      FOR UPDATE OF u
    `;
    await tx.$queryRaw`
      SELECT c."id"
      FROM "recovery_candidate" c
      WHERE c."campaign_id" = ${campaignId}::uuid
        AND c."outcome" = 'pending'
      ORDER BY c."ig_user_id", c."id"
      FOR UPDATE OF c
    `;
    await tx.$queryRaw`
      SELECT "id" FROM "recovery_campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE
    `;

    const campaign = await tx.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    if (
      !campaign ||
      !["draft", "awaiting_approval", "running", "paused"].includes(campaign.state)
    ) {
      return { moved: false, cancelledCandidates: 0, inFlightCandidates: 0 };
    }

    const pending = await tx.recoveryCandidate.findMany({
      where: { campaignId, outcome: "pending" },
      select: { id: true, dispatchStartedAt: true },
      orderBy: [{ igUserId: "asc" }, { id: "asc" }],
    });
    const activeDispatches = pending.length
      ? await tx.publicRecoveryDispatch.findMany({
          where: {
            sourceKind: "historical",
            sourceId: { in: pending.map((candidate) => candidate.id) },
            state: { in: ["reserved", "dispatch_started"] },
          },
          select: { sourceId: true, state: true },
        })
      : [];
    const dispatchState = new Map(
      activeDispatches.map((dispatch) => [dispatch.sourceId, dispatch.state]),
    );
    const inFlight = pending.filter(
      (candidate) =>
        candidate.dispatchStartedAt !== null || dispatchState.get(candidate.id) === "dispatch_started",
    );
    const inFlightIds = new Set(inFlight.map((candidate) => candidate.id));
    const safeToCancel = pending.filter(
      (candidate) => !inFlightIds.has(candidate.id),
    );
    const safeIds = safeToCancel.map((candidate) => candidate.id);

    if (safeIds.length > 0) {
      await tx.publicRecoveryDispatch.updateMany({
        where: {
          sourceKind: "historical",
          sourceId: { in: safeIds },
          state: "reserved",
        },
        data: {
          state: "released",
          releasedAt: now,
          terminalReason: "campaign_cancelled_before_dispatch",
        },
      });
    }

    const cancelled = safeIds.length
      ? await tx.recoveryCandidate.updateMany({
          where: {
            id: { in: safeIds },
            outcome: "pending",
            dispatchStartedAt: null,
          },
          data: {
            outcome: "cancelled",
            suppressionReason: reason,
            claimedAt: null,
            claimExpiresAt: null,
            claimToken: null,
          },
        })
      : { count: 0 };

    await tx.recoveryCampaign.update({
      where: { id: campaignId },
      data: { state: "cancelled", endedAt: now, pauseReason: reason },
    });
    return {
      moved: true,
      cancelledCandidates: cancelled.count,
      inFlightCandidates: inFlight.length,
    };
  });

  if (!result.moved) {
    const current = await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    return { ok: false, reason: current ? `not_cancellable_from_${current.state}` : "not_found" };
  }

  await logEvent("historical_campaign_cancelled", {
    campaignId,
    reason,
    cancelledCandidates: result.cancelledCandidates,
    inFlightCandidates: result.inFlightCandidates,
  });
  return {
    ok: true,
    state: "cancelled",
    cancelledCandidates: result.cancelledCandidates,
    inFlightCandidates: result.inFlightCandidates,
  };
}

/**
 * Close a campaign that has nothing left to send.
 *
 * Separate from cancel: `completed` means it finished its work, `cancelled` means it
 * was stopped. Conflating them would make the outcome data unreadable later.
 */
export async function completeCampaignIfDrained(
  campaignId: string,
  now = new Date(),
): Promise<boolean> {
  const completed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "recovery_campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE
    `;
    const campaign = await tx.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    if (campaign?.state !== "running") return false;

    const actionable = await tx.recoveryCandidate.count({
      where: { campaignId, outcome: "pending", arm: "treatment" },
    });
    if (actionable > 0) return false;
    const activeDispatches = await tx.publicRecoveryDispatch.count({
      where: { campaignId, state: { in: ["reserved", "dispatch_started"] } },
    });
    if (activeDispatches > 0) return false;

    const { count } = await tx.recoveryCampaign.updateMany({
      where: { id: campaignId, state: "running" },
      data: { state: "completed", endedAt: now },
    });
    return count === 1;
  });
  if (!completed) return false;

  await logEvent("historical_campaign_completed", { campaignId });
  return true;
}

/** Recover a campaign whose final row settled before the previous process exited. */
export async function reconcileDrainedCampaigns(now = new Date()): Promise<string[]> {
  const running = await prisma.recoveryCampaign.findMany({
    where: { state: "running" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const completed: string[] = [];
  for (const campaign of running) {
    if (await completeCampaignIfDrained(campaign.id, now)) completed.push(campaign.id);
  }
  return completed;
}

/**
 * Raise a running campaign's caps for the next rollout stage.
 *
 * Stages exist because the copy has never been seen in the wild (§39): 3 → 25 → 100
 * → remainder, each gated on the previous stage showing no complaints and no
 * uncertain sends. Caps are raised rather than the campaign being re-selected, so
 * the approved candidate list never changes underneath the owner.
 *
 * Caps may only go UP. Lowering them would strand candidates the owner already
 * approved without making that visible anywhere.
 */
export async function advanceCampaignStage(
  campaignId: string,
  caps: { batchSize: number; hourlyCap: number; dailyCap: number },
): Promise<CampaignTransition> {
  const campaign = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: { state: true, batchSize: true, hourlyCap: true, dailyCap: true },
  });
  if (!campaign) return { ok: false, reason: "not_found" };
  if (campaign.state !== "running" && campaign.state !== "paused") {
    return { ok: false, reason: `not_stageable_from_${campaign.state}` };
  }
  if (
    caps.batchSize < campaign.batchSize ||
    caps.hourlyCap < campaign.hourlyCap ||
    caps.dailyCap < campaign.dailyCap
  ) {
    return { ok: false, reason: "caps_must_not_decrease" };
  }

  await prisma.recoveryCampaign.update({ where: { id: campaignId }, data: caps });
  await logEvent("historical_campaign_stage_advanced", { campaignId, ...caps });
  return { ok: true, state: campaign.state };
}
