import { prisma } from "../lib/prisma.js";
import { logEvent } from "./eventLogger.js";

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
  | { ok: true; state: string }
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

  const { count } = await prisma.recoveryCampaign.updateMany({
    where: { id: campaignId, state: { in: ["draft", "awaiting_approval"] } },
    data: { state: "running", approvedBy, approvedAt: now, startedAt: now },
  });

  if (count === 0) {
    const current = await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    return { ok: false, reason: current ? `not_approvable_from_${current.state}` : "not_found" };
  }

  // Logged because this is the audit trail for a decision that results in public
  // comments on real people's posts.
  await logEvent("historical_campaign_approved", { campaignId, approvedBy });
  return { ok: true, state: "running" };
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

/** Resume a paused campaign. Approval is already recorded, so it is not re-asked. */
export async function resumeCampaign(campaignId: string): Promise<CampaignTransition> {
  const { count } = await prisma.recoveryCampaign.updateMany({
    // `approvedAt` must already be set — a paused campaign always has it, but the
    // condition makes the invariant explicit rather than assumed.
    where: { id: campaignId, state: "paused", approvedAt: { not: null } },
    data: { state: "running", pausedAt: null, pauseReason: null },
  });

  if (count === 0) {
    const current = await prisma.recoveryCampaign.findUnique({
      where: { id: campaignId },
      select: { state: true },
    });
    return { ok: false, reason: current ? `not_resumable_from_${current.state}` : "not_found" };
  }

  await logEvent("historical_campaign_resumed", { campaignId });
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
    const { count } = await tx.recoveryCampaign.updateMany({
      where: { id: campaignId, state: { in: ["draft", "awaiting_approval", "running", "paused"] } },
      data: { state: "cancelled", endedAt: now, pauseReason: reason },
    });
    if (count === 0) return { moved: false, cancelledCandidates: 0 };

    const candidates = await tx.recoveryCandidate.updateMany({
      where: { campaignId, outcome: "pending" },
      data: { outcome: "cancelled", suppressionReason: reason },
    });
    return { moved: true, cancelledCandidates: candidates.count };
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
  });
  return { ok: true, state: "cancelled" };
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
  const pending = await prisma.recoveryCandidate.count({
    where: { campaignId, outcome: "pending" },
  });
  if (pending > 0) return false;

  const { count } = await prisma.recoveryCampaign.updateMany({
    where: { id: campaignId, state: { in: ["running", "paused"] } },
    data: { state: "completed", endedAt: now },
  });
  if (count === 0) return false;

  await logEvent("historical_campaign_completed", { campaignId });
  return true;
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
