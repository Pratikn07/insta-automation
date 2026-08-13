import { prisma } from "../lib/prisma.js";
import type { Prisma } from "@prisma/client";
import { logEvent } from "./eventLogger.js";
import {
  verifyStoredSelectionSnapshot,
  type SelectionSnapshotConfiguration,
  type SelectionSnapshotInclusion,
} from "./historicalRecoverySnapshot.js";
import {
  classifyIdentityPresence,
  evaluateHistoricalAudience,
  type AudienceSegment,
} from "./historicalAudienceSegment.js";

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

export const PENDING_LAUNCH_PAUSE_REASON = "approved_pending_launch";

export type CampaignApprovalOptions = {
  /** Seal approval while keeping the scheduler unable to claim candidates. */
  startPaused?: boolean;
};

export type GroupPauseResult = {
  rolloutGroupId: string;
  pausedCampaignIds: string[];
  skipped: Array<{ campaignId: string; state: string }>;
};

export class CampaignGroupNotFoundError extends Error {
  readonly code = "campaign_group_not_found";

  constructor() {
    super("campaign_group_not_found");
    this.name = "CampaignGroupNotFoundError";
  }
}

type LockedCampaignGroupMember = { id: string; state: string };

function normalizeCampaignPauseReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("invalid_campaign_pause_reason");
  }
  return normalized;
}

/** Shared first lock for dispatch, health stops, and owner campaign control. */
export async function lockRecoveryCampaignControl(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
}

/** Lock every member of one rollout group in the canonical campaign-ID order. */
export async function lockCampaignGroupMembers(
  tx: Prisma.TransactionClient,
  rolloutGroupId: string,
): Promise<LockedCampaignGroupMember[]> {
  return tx.$queryRaw<LockedCampaignGroupMember[]>`
    SELECT "id", "state"::text AS "state"
    FROM "recovery_campaign"
    WHERE "rollout_group_id" = ${rolloutGroupId}::uuid
    ORDER BY "id"
    FOR UPDATE
  `;
}

/** Apply a group pause after the singleton and ordered campaign locks are held. */
export async function pauseLockedCampaignGroup(
  tx: Prisma.TransactionClient,
  rolloutGroupId: string,
  members: LockedCampaignGroupMember[],
  reason: string,
  now: Date,
): Promise<GroupPauseResult> {
  const normalizedReason = normalizeCampaignPauseReason(reason);
  if (members.length === 0) throw new CampaignGroupNotFoundError();
  const pausedCampaignIds = members
    .filter((member) => member.state === "running")
    .map((member) => member.id);
  const skipped = members
    .filter((member) => member.state !== "running")
    .map((member) => ({ campaignId: member.id, state: member.state }));

  if (pausedCampaignIds.length > 0) {
    const paused = await tx.recoveryCampaign.updateMany({
      where: { id: { in: pausedCampaignIds }, state: "running" },
      data: { state: "paused", pausedAt: now, pauseReason: normalizedReason },
    });
    if (paused.count !== pausedCampaignIds.length) {
      throw new Error("campaign_group_pause_count_mismatch");
    }
  }

  const result = { rolloutGroupId, pausedCampaignIds, skipped };
  await tx.eventLog.create({
    data: {
      kind: "historical_campaign_group_paused",
      payload: {
        rolloutGroupId: result.rolloutGroupId,
        reason: normalizedReason,
        pausedCampaignIds: result.pausedCampaignIds,
        skipped: result.skipped,
      },
    },
  });
  return result;
}

/** Rebuild the exact owner-reviewed manifest from its frozen database rows. */
async function readStoredSelectionSnapshot(
  tx: Prisma.TransactionClient,
  campaignId: string,
) {
  const current = await tx.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: {
      state: true,
      approvedBy: true,
      approvedAt: true,
      pauseReason: true,
      startedAt: true,
      phase: true,
      selectionVersion: true,
      sourceDataCutoff: true,
      commentFrom: true,
      commentTo: true,
      selectionLimit: true,
      holdoutPercent: true,
      copyVersion: true,
      batchSize: true,
      hourlyCap: true,
      dailyCap: true,
      selectionFingerprint: true,
      eligibilityPolicyVersion: true,
      westernOnly: true,
      inboundWindowHours: true,
      completionWindowHours: true,
      audienceSegment: true,
      rolloutGroupId: true,
      rolloutGroupHourlyCap: true,
      candidateCount: true,
      excludedCount: true,
      decisionHash: true,
    },
  });
  if (!current) return null;

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
      audienceOriginMethod: true,
      audienceOriginConfidence: true,
      audienceSegment: true,
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
          selectionLimit: current.selectionLimit,
          westernOnly: current.westernOnly,
          holdoutPercent: current.holdoutPercent,
          copyVersion: current.copyVersion,
          eligibilityPolicyVersion: current.eligibilityPolicyVersion,
          inboundWindowHours: current.inboundWindowHours,
          completionWindowHours: current.completionWindowHours,
          ...(current.eligibilityPolicyVersion === "eligibility-v4-expanded-audience" ? {
            audienceSegment: current.audienceSegment,
            rolloutGroupId: current.rolloutGroupId,
            rolloutGroupHourlyCap: current.rolloutGroupHourlyCap,
          } : {}),
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
    audienceOriginMethod: candidate.audienceOriginMethod,
    audienceOriginConfidence: candidate.audienceOriginConfidence,
    ...(current.eligibilityPolicyVersion === "eligibility-v4-expanded-audience"
      ? { audienceSegment: candidate.audienceSegment }
      : {}),
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

  return {
    current,
    snapshot: {
      configuration,
      selectionFingerprint: current.selectionFingerprint,
      decisionHash: current.decisionHash,
      candidateCount: current.candidateCount,
      excludedCount: current.excludedCount,
      inclusions,
      exclusions: storedExclusions,
    },
  };
}

/**
 * Approve a campaign, either starting it or sealing it in a pending-launch pause.
 *
 * This is the moment selection is frozen, so it records WHO approved and when —
 * `chk_campaign_approval_complete` requires both,
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
  options: CampaignApprovalOptions = {},
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
    const stored = await readStoredSelectionSnapshot(tx, campaignId);
    if (!stored) return { kind: "blocked", reason: "not_found" } as const;
    const { current, snapshot } = stored;
    if (current.rolloutGroupId) {
      return { kind: "blocked", reason: "grouped_campaign_requires_atomic_approval" } as const;
    }
    if (!(["draft", "awaiting_approval"] as string[]).includes(current.state)) {
      return {
        kind: "blocked",
        reason: `not_approvable_from_${current.state}`,
      } as const;
    }
    const verified = verifyStoredSelectionSnapshot(snapshot);
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
    const state = treatmentPending === 0
      ? "completed"
      : options.startPaused
        ? "paused"
        : "running";
    const pendingLaunch = state === "paused";
    await tx.recoveryCampaign.update({
      where: { id: campaignId },
      data: {
        state,
        approvedBy,
        approvedAt: now,
        startedAt: pendingLaunch ? null : now,
        ...(pendingLaunch
          ? {
              pausedAt: now,
              pauseReason: PENDING_LAUNCH_PAUSE_REASON,
            }
          : {}),
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

const EXPANDED_SEGMENT_ORDER = [
  "other", "unknown_cue", "unknown_generic", "unknown_no_name",
] as const satisfies readonly AudienceSegment[];

type ExpandedCampaignIdentity = {
  id: string;
  segment: (typeof EXPANDED_SEGMENT_ORDER)[number];
  decisionHash: string;
};

export type ExpandedCampaignGroupTransitionInput = {
  rolloutGroupId: string;
  campaigns: ExpandedCampaignIdentity[];
  selectorPhase: "confirmed_failure" | "unknown_read_pilot";
};

export type ExpandedCampaignGroupTransition = CampaignTransition & {
  campaignIds?: string[];
};

function validExpandedCampaignTopology(campaigns: ExpandedCampaignIdentity[]): boolean {
  if (campaigns.length < 1 || campaigns.length > 4) return false;
  const ids = new Set<string>();
  let previousIndex = -1;
  for (const campaign of campaigns) {
    const index = EXPANDED_SEGMENT_ORDER.indexOf(campaign.segment);
    if (
      index <= previousIndex
      || ids.has(campaign.id)
      || !/^[a-f0-9]{64}$/.test(campaign.decisionHash)
    ) return false;
    previousIndex = index;
    ids.add(campaign.id);
  }
  return true;
}

type VerifiedExpandedGroup = {
  campaignIds: string[];
  stored: NonNullable<Awaited<ReturnType<typeof readStoredSelectionSnapshot>>>[];
};

async function verifyLockedExpandedGroup(
  tx: Prisma.TransactionClient,
  input: ExpandedCampaignGroupTransitionInput,
  allowedStates: readonly string[],
  now: Date,
): Promise<{ ok: true; value: VerifiedExpandedGroup } | { ok: false; reason: string }> {
  if (!validExpandedCampaignTopology(input.campaigns)) {
    return { ok: false, reason: "expanded_group_topology_invalid" };
  }
  const members = await lockCampaignGroupMembers(tx, input.rolloutGroupId);
  const campaignIds = input.campaigns.map(({ id }) => id);
  if (
    members.length !== campaignIds.length
    || members.some(({ id, state }) => !campaignIds.includes(id) || !allowedStates.includes(state))
  ) {
    return { ok: false, reason: "expanded_group_set_or_state_mismatch" };
  }

  await tx.$queryRaw`
    SELECT u."id"
    FROM "ig_users" u
    JOIN "recovery_candidate" k ON k."ig_user_id"=u."id"
    JOIN "recovery_campaign" c ON c."id"=k."campaign_id"
    WHERE c."rollout_group_id"=${input.rolloutGroupId}::uuid
    ORDER BY u."id" FOR UPDATE OF u
  `;
  await tx.$queryRaw`
    SELECT k."id" FROM "recovery_candidate" k
    JOIN "recovery_campaign" c ON c."id"=k."campaign_id"
    WHERE c."rollout_group_id"=${input.rolloutGroupId}::uuid
    ORDER BY k."ig_user_id", k."id" FOR UPDATE OF k
  `;
  await tx.$queryRaw`
    SELECT s."id" FROM "recovery_candidate_source" s
    JOIN "recovery_candidate" k ON k."id"=s."candidate_id"
    JOIN "recovery_campaign" c ON c."id"=k."campaign_id"
    WHERE c."rollout_group_id"=${input.rolloutGroupId}::uuid
    ORDER BY k."ig_user_id", k."id", s."position" FOR UPDATE OF s
  `;
  await tx.$queryRaw`
    SELECT e."id" FROM "recovery_selection_exclusion" e
    JOIN "recovery_campaign" c ON c."id"=e."campaign_id"
    WHERE c."rollout_group_id"=${input.rolloutGroupId}::uuid
    ORDER BY e."campaign_id", e."intent_id" FOR UPDATE OF e
  `;

  const stored = [] as VerifiedExpandedGroup["stored"];
  let firstFailure: string | null = null;
  const people = new Set<string>();
  for (const expected of input.campaigns) {
    const value = await readStoredSelectionSnapshot(tx, expected.id);
    if (!value) {
      firstFailure ??= "not_found";
      continue;
    }
    stored.push(value);
    const { current, snapshot } = value;
    const verified = verifyStoredSelectionSnapshot(snapshot);
    if (!verified.ok) firstFailure ??= verified.reason;
    if (
      current.phase !== input.selectorPhase
      || current.decisionHash !== expected.decisionHash
      || snapshot.decisionHash !== expected.decisionHash
      || current.selectionVersion !== "v1-canonical-intents-expanded-audience"
      || current.copyVersion !== "recovery-v2"
      || current.eligibilityPolicyVersion !== "eligibility-v4-expanded-audience"
      || current.audienceSegment !== expected.segment
      || current.rolloutGroupId !== input.rolloutGroupId
      || current.rolloutGroupHourlyCap !== 10
      || current.holdoutPercent !== 0
      || current.batchSize !== 1
      || current.hourlyCap !== 10
      || current.dailyCap !== 1000
      || current.candidateCount <= 0
      || snapshot.inclusions.some(({ arm, audienceSegment }) =>
        arm !== "treatment" || audienceSegment !== expected.segment)
    ) firstFailure ??= "expanded_group_audit_failed";
    for (const inclusion of snapshot.inclusions) {
      if (people.has(inclusion.igUserId)) firstFailure ??= "expanded_group_duplicate_person";
      people.add(inclusion.igUserId);
    }
  }

  const users = await tx.igUser.findMany({
    where: { id: { in: [...people] } },
    select: {
      id: true,
      username: true,
      name: true,
      audienceSegment: true,
      inferredOrigin: true,
      originConfidence: true,
      originMethod: true,
    },
  });
  const usersById = new Map(users.map((user) => [user.id, user]));
  for (const value of stored) {
    const segment = value.current.audienceSegment;
    for (const inclusion of value.snapshot.inclusions) {
      const user = usersById.get(inclusion.igUserId);
      const decision = evaluateHistoricalAudience({
        segment: user?.audienceSegment ?? null,
        origin: user?.inferredOrigin ?? null,
        confidence: user?.originConfidence ?? null,
        method: user?.originMethod ?? null,
      });
      const identityPresence = user
        ? classifyIdentityPresence({ username: user.username, name: user.name })
        : null;
      const identityMatchesSegment = segment === "unknown_no_name"
        ? identityPresence === "unknown_no_name"
          && user?.inferredOrigin === "unknown"
          && user.originConfidence === "low"
        : identityPresence === null && user?.audienceSegment !== "unknown_no_name";
      if (
        decision.kind !== "allow"
        || !identityMatchesSegment
        || user?.audienceSegment !== segment
        || inclusion.audienceSegment !== segment
        || inclusion.audienceOrigin !== user.inferredOrigin
        || inclusion.audienceOriginMethod !== user.originMethod
        || inclusion.audienceOriginConfidence !== user.originConfidence
      ) firstFailure ??= "expanded_group_live_audience_mismatch";
    }
  }
  // Dispatch reservation takes the same singleton lock first, so this count cannot
  // increase until the approval/resume transaction commits.
  const rollingCapacity = await tx.publicRecoveryDispatch.count({
    where: {
      campaign: { rolloutGroupId: input.rolloutGroupId },
      state: { in: ["reserved", "dispatch_started", "sent", "uncertain"] },
      reservedAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (rollingCapacity > 10) firstFailure ??= "expanded_group_capacity_exceeded";
  if (firstFailure) return { ok: false, reason: firstFailure };
  return { ok: true, value: { campaignIds, stored } };
}

/** Seal every expanded campaign in one transaction after all manifests validate. */
export async function approveCampaignGroup(
  input: ExpandedCampaignGroupTransitionInput & { approvedBy: string },
  now = new Date(),
): Promise<ExpandedCampaignGroupTransition> {
  if (!input.approvedBy.trim()) return { ok: false, reason: "approver_required" };
  return prisma.$transaction(async (tx) => {
    await lockRecoveryCampaignControl(tx);
    const verified = await verifyLockedExpandedGroup(
      tx,
      input,
      ["draft", "awaiting_approval", "paused"],
      now,
    );
    if (!verified.ok) return verified;
    const draftIds = verified.value.stored.flatMap(({ current }, index) =>
      current.state === "draft" || current.state === "awaiting_approval"
        ? [input.campaigns[index]!.id]
        : []);
    if (draftIds.length > 0) {
      const withheld = await tx.recoveryCandidate.updateMany({
        where: { campaignId: { in: draftIds }, arm: "holdout", outcome: "pending" },
        data: { outcome: "holdout_withheld", suppressionReason: "holdout_arm" },
      });
      if (withheld.count !== 0) throw new Error("expanded_group_holdout_present");
      const updated = await tx.recoveryCampaign.updateMany({
        where: { id: { in: draftIds }, state: { in: ["draft", "awaiting_approval"] } },
        data: {
          state: "paused",
          approvedBy: input.approvedBy.trim(),
          approvedAt: now,
          startedAt: null,
          pausedAt: now,
          pauseReason: PENDING_LAUNCH_PAUSE_REASON,
          endedAt: null,
        },
      });
      if (updated.count !== draftIds.length) throw new Error("expanded_group_approval_count_mismatch");
    }
    const emergencyPausedIds = verified.value.stored.flatMap(({ current }, index) =>
      current.state === "paused" && current.pauseReason?.startsWith("emergency:")
        ? [input.campaigns[index]!.id]
        : []);
    if (emergencyPausedIds.length > 0) {
      const updated = await tx.recoveryCampaign.updateMany({
        where: {
          id: { in: emergencyPausedIds },
          state: "paused",
        },
        data: {
          approvedBy: input.approvedBy.trim(),
          approvedAt: now,
          pausedAt: now,
          pauseReason: PENDING_LAUNCH_PAUSE_REASON,
        },
      });
      if (updated.count !== emergencyPausedIds.length) {
        throw new Error("expanded_group_reapproval_count_mismatch");
      }
    }
    await tx.eventLog.create({
      data: {
        kind: "historical_campaign_group_approved",
        payload: { rolloutGroupId: input.rolloutGroupId, campaignIds: verified.value.campaignIds, approvedBy: input.approvedBy.trim() },
      },
    });
    return { ok: true, state: "paused", campaignIds: verified.value.campaignIds };
  });
}

/** Start every approved member in one transaction after a fresh full-group verification. */
export async function resumeCampaignGroup(
  input: ExpandedCampaignGroupTransitionInput,
  now = new Date(),
): Promise<ExpandedCampaignGroupTransition> {
  return prisma.$transaction(async (tx) => {
    await lockRecoveryCampaignControl(tx);
    const verified = await verifyLockedExpandedGroup(tx, input, ["paused", "completed"], now);
    if (!verified.ok) return verified;
    if (verified.value.stored.some(({ current }) =>
      current.state === "paused"
      && (
        !current.approvedAt
        || current.pauseReason?.startsWith("auto:")
        || current.pauseReason?.startsWith("emergency:")
      ))) {
      return { ok: false, reason: "expanded_group_not_safely_resumable" };
    }
    const firstLaunchIds = verified.value.stored.flatMap(({ current }, index) =>
      current.state === "paused" && current.startedAt === null
        ? [input.campaigns[index]!.id]
        : []);
    const previouslyLaunchedIds = verified.value.stored.flatMap(({ current }, index) =>
      current.state === "paused" && current.startedAt !== null
        ? [input.campaigns[index]!.id]
        : []);
    if (firstLaunchIds.length > 0) {
      const updated = await tx.recoveryCampaign.updateMany({
        where: {
          id: { in: firstLaunchIds },
          state: "paused",
          approvedAt: { not: null },
          startedAt: null,
        },
        data: { state: "running", startedAt: now, pausedAt: null, pauseReason: null },
      });
      if (updated.count !== firstLaunchIds.length) {
        throw new Error("expanded_group_resume_count_mismatch");
      }
    }
    if (previouslyLaunchedIds.length > 0) {
      const updated = await tx.recoveryCampaign.updateMany({
        where: {
          id: { in: previouslyLaunchedIds },
          state: "paused",
          approvedAt: { not: null },
          startedAt: { not: null },
        },
        data: { state: "running", pausedAt: null, pauseReason: null },
      });
      if (updated.count !== previouslyLaunchedIds.length) {
        throw new Error("expanded_group_resume_count_mismatch");
      }
    }
    await tx.eventLog.create({
      data: {
        kind: "historical_campaign_group_resumed",
        payload: { rolloutGroupId: input.rolloutGroupId, campaignIds: verified.value.campaignIds },
      },
    });
    return { ok: true, state: "running", campaignIds: verified.value.campaignIds };
  });
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

/** Pause every running member of one expanded rollout group as one owner action. */
export async function pauseCampaignGroup(
  rolloutGroupId: string,
  reason: string,
  now = new Date(),
): Promise<GroupPauseResult> {
  const normalizedReason = normalizeCampaignPauseReason(reason);
  const result = await prisma.$transaction(async (tx) => {
    await lockRecoveryCampaignControl(tx);
    const members = await lockCampaignGroupMembers(tx, rolloutGroupId);
    return pauseLockedCampaignGroup(tx, rolloutGroupId, members, normalizedReason, now);
  });
  return result;
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
  now = new Date(),
): Promise<CampaignTransition> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
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

    const stored = await readStoredSelectionSnapshot(tx, campaignId);
    if (!stored) return { kind: "blocked", reason: "not_found" } as const;
    const { current, snapshot } = stored;
    if (current.rolloutGroupId) {
      return { kind: "blocked", reason: "grouped_campaign_requires_atomic_resume" } as const;
    }
    if (current.state !== "paused") {
      return { kind: "blocked", reason: `not_resumable_from_${current.state}` } as const;
    }
    const verified = verifyStoredSelectionSnapshot(snapshot);
    if (!verified.ok) return { kind: "blocked", reason: verified.reason } as const;

    const autoPaused = current.pauseReason?.startsWith("auto:") ?? false;
    if (autoPaused && !options.acknowledgeAutoPause?.trim()) {
      return {
        kind: "blocked",
        reason: `auto_pause_requires_review:${current.pauseReason}`,
      } as const;
    }

    const { count } = await tx.recoveryCampaign.updateMany({
      // `approvedAt` must already be set — a paused campaign always has it, but the
      // condition makes the invariant explicit rather than assumed. Re-checking `paused`
      // closes the gap between the read above and this write.
      where: {
        id: campaignId,
        state: "paused",
        approvedAt: { not: null },
        selectionFingerprint: { not: null },
        decisionHash: { not: null },
        eligibilityPolicyVersion: { not: null },
        westernOnly: { not: null },
      },
      data: {
        state: "running",
        ...(current.startedAt === null ? { startedAt: now } : {}),
        pausedAt: null,
        pauseReason: null,
      },
    });
    if (count === 0) {
      const now = await tx.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true },
      });
      return {
        kind: "blocked",
        reason: now ? `not_resumable_from_${now.state}` : "not_found",
      } as const;
    }
    return { kind: "moved", autoPaused, pauseReason: current.pauseReason } as const;
  });

  if (result.kind === "blocked") return { ok: false, reason: result.reason };

  await logEvent("historical_campaign_resumed", {
    campaignId,
    // The audit trail for overriding an automatic stop.
    overrodeAutoPause: result.autoPaused ? result.pauseReason : null,
    acknowledgedBy: result.autoPaused ? (options.acknowledgeAutoPause ?? null) : null,
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
 * Caps may only go UP after launch. A campaign approved into the pending-launch
 * pause may replace draft defaults once before the scheduler can see it.
 */
export async function advanceCampaignStage(
  campaignId: string,
  caps: { batchSize: number; hourlyCap: number; dailyCap: number },
): Promise<CampaignTransition> {
  const campaign = await prisma.recoveryCampaign.findUnique({
    where: { id: campaignId },
    select: {
      state: true,
      batchSize: true,
      hourlyCap: true,
      dailyCap: true,
      approvedAt: true,
      startedAt: true,
      pauseReason: true,
    },
  });
  if (!campaign) return { ok: false, reason: "not_found" };
  if (campaign.state !== "running" && campaign.state !== "paused") {
    return { ok: false, reason: `not_stageable_from_${campaign.state}` };
  }
  const configuringPendingLaunch =
    campaign.state === "paused"
    && campaign.approvedAt !== null
    && campaign.startedAt === null
    && campaign.pauseReason === PENDING_LAUNCH_PAUSE_REASON;
  if (
    !configuringPendingLaunch
    && (
      caps.batchSize < campaign.batchSize
      || caps.hourlyCap < campaign.hourlyCap
      || caps.dailyCap < campaign.dailyCap
    )
  ) {
    return { ok: false, reason: "caps_must_not_decrease" };
  }

  await prisma.recoveryCampaign.update({ where: { id: campaignId }, data: caps });
  await logEvent("historical_campaign_stage_advanced", { campaignId, ...caps });
  return { ok: true, state: campaign.state };
}
