import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getIgUsers } from "../services/igUserService.js";
import { env } from "../config/env.js";
import {
  approveCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  advanceCampaignStage,
} from "../services/recoveryCampaignControl.js";

/**
 * Read models and owner actions for historical recovery campaigns.
 *
 * Deliberately separate from /recovery-reminders. The design (§40) keeps the
 * historical lens apart from the prospective Ready/Sent tabs because the two answer
 * different questions — "is the automation working now" versus "should we reach back
 * to people we already failed" — and mixing them would let an owner approve 985
 * public comments while thinking they were reviewing today's queue.
 *
 * Mounted under apiRouter, so requireAdmin has already run.
 */
export const historicalRecoveryRouter = Router();

export const CANDIDATE_VIEWS = [
  "all",
  "pending",
  "sent",
  "suppressed",
  "attention",
  "holdout",
  "recovered",
] as const;

export type CandidateView = (typeof CANDIDATE_VIEWS)[number];

/**
 * One definition of what each view means, shared by the list and the counts so a
 * row can never appear in a tab whose badge disagrees with it.
 */
export function candidateViewWhere(view: CandidateView): Prisma.RecoveryCandidateWhereInput {
  switch (view) {
    case "pending":
      // Treatment only: a holdout row is never "waiting to send", it is the control.
      return { outcome: "pending", arm: "treatment" };
    case "sent":
      return { outcome: "sent" };
    case "suppressed":
      return { outcome: { in: ["suppressed", "cancelled"] } };
    // Rows a human must look at. `send_uncertain` may already have posted, so it is
    // never retried automatically and must not sit silently in a list.
    case "attention":
      return { outcome: { in: ["send_uncertain", "send_failed"] } };
    case "holdout":
      return { arm: "holdout" };
    // Everyone who completed the request after their candidate was settled (QA-12).
    //
    // Both arms, because the number is only meaningful as a comparison: treatment is
    // "the reminder worked", holdout is "they would have come back anyway". Filtering to
    // `sent` alone hid the baseline, so any treatment figure read as pure lift.
    //
    // `send_uncertain` counts as contacted: the comment may well be live, and excluding
    // it would drop real recoveries from the numerator.
    case "recovered":
      return {
        laterCompletedAt: { not: null },
        outcome: { in: ["sent", "send_uncertain", "holdout_withheld"] },
      };
    case "all":
    default:
      return {};
  }
}

/** Campaign list with per-campaign progress, newest first. */
historicalRecoveryRouter.get("/campaigns", async (_req, res) => {
  const campaigns = await prisma.recoveryCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // One grouped query rather than one per campaign: at 985 candidates a per-row
  // loop would issue a query per outcome per campaign.
  const grouped = await prisma.recoveryCandidate.groupBy({
    by: ["campaignId", "outcome", "arm"],
    _count: { _all: true },
  });

  const progress = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const bucket = progress.get(row.campaignId) ?? {};
    bucket[row.outcome] = (bucket[row.outcome] ?? 0) + row._count._all;
    if (row.arm === "holdout") bucket.holdout = (bucket.holdout ?? 0) + row._count._all;
    progress.set(row.campaignId, bucket);
  }

  res.json({
    // Surfaced so the dashboard can say "sending is off" rather than showing an
    // approved campaign that silently never sends.
    sendingEnabled: env.DM_RECOVERY_ENABLED && env.DM_RECOVERY_HISTORICAL_ENABLED,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      phase: c.phase,
      state: c.state,
      selectionVersion: c.selectionVersion,
      copyVersion: c.copyVersion,
      sourceDataCutoff: c.sourceDataCutoff.toISOString(),
      holdoutPercent: c.holdoutPercent,
      batchSize: c.batchSize,
      hourlyCap: c.hourlyCap,
      dailyCap: c.dailyCap,
      candidateCount: c.candidateCount,
      excludedCount: c.excludedCount,
      approvedBy: c.approvedBy,
      approvedAt: c.approvedAt?.toISOString() ?? null,
      startedAt: c.startedAt?.toISOString() ?? null,
      pausedAt: c.pausedAt?.toISOString() ?? null,
      pauseReason: c.pauseReason,
      endedAt: c.endedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      progress: progress.get(c.id) ?? {},
    })),
  });
});

const listQuery = z.object({
  campaignId: z.string().uuid().optional(),
  view: z.enum(CANDIDATE_VIEWS).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
  // Pins the pagination boundary so rows cannot shift between pages while the
  // worker is sending — the same fix applied to the prospective list.
  asOf: z.string().datetime().optional(),
});

/** Candidate list for one view, with the counts every tab badge reads from. */
historicalRecoveryRouter.get("/candidates", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", detail: parsed.error.flatten() });
    return;
  }
  const { campaignId, view, limit, cursor } = parsed.data;

  const base: Prisma.RecoveryCandidateWhereInput = campaignId ? { campaignId } : {};
  const where: Prisma.RecoveryCandidateWhereInput = { ...base, ...candidateViewWhere(view) };

  const rows = await prisma.recoveryCandidate.findMany({
    where,
    orderBy: [{ commentAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Usernames come from the same resolver the rest of the dashboard uses, so a
  // person reads as @handle here and in Conversations rather than a numeric id.
  // Returns a keyed record, not an array.
  const usersById = await getIgUsers(page.map((r) => r.igUserId));

  // Every view's count in one pass, so a tab badge can never disagree with the
  // list it opens.
  const counts: Record<string, number> = {};
  await Promise.all(
    CANDIDATE_VIEWS.map(async (v) => {
      counts[v] = await prisma.recoveryCandidate.count({
        where: { ...base, ...candidateViewWhere(v) },
      });
    }),
  );

  res.json({
    counts,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    candidates: page.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      igUserId: r.igUserId,
      username: usersById[r.igUserId]?.username ?? null,
      keywordSnapshot: r.keywordSnapshot,
      commentId: r.commentId,
      mediaId: r.mediaId,
      commentAt: r.commentAt.toISOString(),
      publicReplyText: r.publicReplyText,
      evidence: r.evidence,
      arm: r.arm,
      outcome: r.outcome,
      // The snapshot, not the live verdict: this is what the filter believed when
      // the campaign was approved, which is what an audit needs.
      audienceOrigin: r.audienceOrigin,
      audienceOriginConfidence: r.audienceOriginConfidence,
      sentAt: r.sentAt?.toISOString() ?? null,
      publicReplyId: r.publicReplyId,
      suppressionReason: r.suppressionReason,
      laterInboundAt: r.laterInboundAt?.toISOString() ?? null,
      laterCompletedAt: r.laterCompletedAt?.toISOString() ?? null,
    })),
  });
});

const approveBody = z.object({ approvedBy: z.string().min(1).max(120) });

/**
 * Approve a campaign — the moment public comments become possible.
 *
 * The approver is required by the body schema and by
 * chk_campaign_approval_complete: an unattributable approval is not an audit trail
 * for an action that posts on real people's posts.
 */
historicalRecoveryRouter.post("/campaigns/:id/approve", async (req, res) => {
  const body = approveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "approver_required" });
    return;
  }

  const result = await approveCampaign(req.params.id, body.data.approvedBy);
  if (!result.ok) {
    // 409, not 400: the request was well-formed, the campaign was simply not in a
    // state this action applies to.
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});

const reasonBody = z.object({ reason: z.string().min(1).max(300) });

historicalRecoveryRouter.post("/campaigns/:id/pause", async (req, res) => {
  const body = reasonBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "reason_required" });
    return;
  }
  const result = await pauseCampaign(req.params.id, body.data.reason);
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});

/**
 * Resume a paused campaign.
 *
 * An automatically paused campaign requires an acknowledgement naming who is overriding
 * the stop (QA-13). Without it the resume is refused and the 409 carries the auto-pause
 * reason, so the caller can show the owner exactly what they would be overriding.
 */
const resumeBody = z.object({ acknowledgeAutoPause: z.string().min(1).max(300).optional() });

historicalRecoveryRouter.post("/campaigns/:id/resume", async (req, res) => {
  const body = resumeBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "invalid_acknowledgement" });
    return;
  }
  const result = await resumeCampaign(req.params.id, body.data);
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});

historicalRecoveryRouter.post("/campaigns/:id/cancel", async (req, res) => {
  const body = reasonBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "reason_required" });
    return;
  }
  const result = await cancelCampaign(req.params.id, body.data.reason);
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});

const stageBody = z.object({
  batchSize: z.coerce.number().int().min(1).max(50),
  hourlyCap: z.coerce.number().int().min(1).max(200),
  dailyCap: z.coerce.number().int().min(1).max(1000),
});

/**
 * Advance to the next rollout stage by raising caps.
 *
 * Caps go up, never down — the service enforces it. Raising caps rather than
 * re-selecting means the approved candidate list never changes underneath the owner.
 */
historicalRecoveryRouter.post("/campaigns/:id/stage", async (req, res) => {
  const body = stageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "invalid_caps", detail: body.error.flatten() });
    return;
  }
  const result = await advanceCampaignStage(req.params.id, body.data);
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});
