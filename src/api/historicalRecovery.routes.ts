import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getIgUsers } from "../services/igUserService.js";
import { env } from "../config/env.js";
import {
  approveCampaign,
  pauseCampaign,
  pauseCampaignGroup,
  resumeCampaign,
  cancelCampaign,
  advanceCampaignStage,
} from "../services/recoveryCampaignControl.js";
import { recordCampaignHealthObservation } from "../services/campaignHealthObservation.js";
import { logEvent } from "../services/eventLogger.js";
import { historicalCandidateDetail } from "../services/historicalRecoveryCandidateDetail.js";
import {
  markHistoricalCandidateReviewed,
} from "../services/historicalRecoveryReview.js";

export { HISTORICAL_REVIEWABLE_OUTCOMES } from "../services/historicalRecoveryReview.js";

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

type HistoricalAttributionObservationInput = {
  arm: "treatment" | "holdout";
  dispatchStartedAt: Date | null;
  sentAt: Date | null;
  lastAttemptAt: Date | null;
  campaignStartedAt: Date | null;
  laterInboundAt: Date | null;
  laterCompletedAt: Date | null;
};

/** Fixed experiment observations, independent of when the API happens to be read. */
export function buildHistoricalAttributionObservation(
  input: HistoricalAttributionObservationInput,
): {
  anchorAt: Date | null;
  inboundWithin24Hours: boolean;
  completedWithin48Hours: boolean;
} {
  const anchorAt = input.arm === "treatment"
    ? input.dispatchStartedAt ?? input.sentAt ?? input.lastAttemptAt
    : input.campaignStartedAt;
  const within = (observedAt: Date | null, hours: number): boolean => Boolean(
    anchorAt
      && observedAt
      && observedAt.getTime() >= anchorAt.getTime()
      && observedAt.getTime() <= anchorAt.getTime() + hours * 3600_000,
  );
  return {
    anchorAt,
    inboundWithin24Hours: within(input.laterInboundAt, 24),
    completedWithin48Hours: within(input.laterCompletedAt, 48),
  };
}

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

/**
 * IDs that qualify for the fixed 48-hour recovered observation.
 *
 * The writer already enforces each campaign's configured upper bound. Rechecking the
 * fixed reporting bound here also protects the operator view from legacy or manually
 * imported timestamps that predate that invariant.
 */
async function listBoundedRecoveredCandidateIds(campaignId: string | undefined, asOf: Date): Promise<string[]> {
  const requestedCampaignId = campaignId ?? null;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT candidate."id"
    FROM "recovery_candidate" candidate
    JOIN "recovery_campaign" campaign ON campaign."id" = candidate."campaign_id"
    WHERE (${requestedCampaignId}::uuid IS NULL OR candidate."campaign_id" = ${requestedCampaignId}::uuid)
      AND candidate."created_at" <= ${asOf}
      AND candidate."later_completed_at" IS NOT NULL
      AND candidate."outcome" IN ('sent', 'send_uncertain', 'holdout_withheld')
      AND candidate."later_completed_at" >= CASE
        WHEN candidate."arm" = 'treatment' THEN
          COALESCE(
            candidate."dispatch_started_at",
            candidate."sent_at",
            candidate."last_attempt_at"
          )
        ELSE campaign."started_at"
      END
      AND candidate."later_completed_at" <= CASE
        WHEN candidate."arm" = 'treatment' THEN
          COALESCE(
            candidate."dispatch_started_at",
            candidate."sent_at",
            candidate."last_attempt_at"
          )
        ELSE campaign."started_at"
      END + INTERVAL '48 hours'
  `;
  return rows.map((row) => row.id);
}

/** Campaign list with per-campaign progress, newest first. */
historicalRecoveryRouter.get("/campaigns", async (_req, res) => {
  const campaigns = await prisma.recoveryCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const campaignIds = campaigns.map((campaign) => campaign.id);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // One grouped query rather than one per campaign: at 985 candidates a per-row
  // loop would issue a query per outcome per campaign.
  const [grouped, attributionRows, rolloutGroupCapacity] = await Promise.all([
    prisma.recoveryCandidate.groupBy({
      by: ["campaignId", "outcome", "arm"],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.recoveryCandidate.findMany({
      where: { campaignId: { in: campaignIds } },
      select: {
        campaignId: true,
        arm: true,
        dispatchStartedAt: true,
        sentAt: true,
        lastAttemptAt: true,
        laterInboundAt: true,
        laterCompletedAt: true,
        campaign: { select: { startedAt: true } },
      },
    }),
    // A group is the capacity boundary. Count every campaign in it, rather than
    // only the campaign selected in this dashboard, so this read model cannot make
    // a shared 10/hour limit look like four independent limits.
    prisma.$queryRaw<Array<{ rolloutGroupId: string; sentLastHour: number }>>`
      SELECT campaign."rollout_group_id" AS "rolloutGroupId", COUNT(*)::int AS "sentLastHour"
      FROM "public_recovery_dispatch" dispatch
      JOIN "recovery_campaign" campaign ON campaign."id" = dispatch."campaign_id"
      WHERE campaign."rollout_group_id" IS NOT NULL
        AND dispatch."state" IN ('reserved', 'dispatch_started', 'sent', 'uncertain')
        AND dispatch."reserved_at" > ${hourAgo}
      GROUP BY campaign."rollout_group_id"
    `,
  ]);

  const rolloutCapacityByGroup = new Map(
    rolloutGroupCapacity.map((row) => [row.rolloutGroupId, row.sentLastHour]),
  );

  const progress = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const bucket = progress.get(row.campaignId) ?? {};
    bucket[row.outcome] = (bucket[row.outcome] ?? 0) + row._count._all;
    if (row.arm === "holdout") bucket.holdout = (bucket.holdout ?? 0) + row._count._all;
    progress.set(row.campaignId, bucket);
  }
  for (const row of attributionRows) {
    const observation = buildHistoricalAttributionObservation({
      ...row,
      campaignStartedAt: row.campaign.startedAt,
    });
    const bucket = progress.get(row.campaignId) ?? {};
    if (observation.inboundWithin24Hours) {
      bucket.inbound24h = (bucket.inbound24h ?? 0) + 1;
      const key = row.arm === "treatment" ? "treatmentInbound24h" : "holdoutInbound24h";
      bucket[key] = (bucket[key] ?? 0) + 1;
    }
    if (observation.completedWithin48Hours) {
      bucket.completed48h = (bucket.completed48h ?? 0) + 1;
      const key = row.arm === "treatment" ? "treatmentCompleted48h" : "holdoutCompleted48h";
      bucket[key] = (bucket[key] ?? 0) + 1;
    }
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
      selectionFingerprint: c.selectionFingerprint,
      decisionHash: c.decisionHash,
      audienceSegment: c.audienceSegment,
      rolloutGroupId: c.rolloutGroupId,
      rolloutGroupHourlyCap: c.rolloutGroupHourlyCap,
      // Ungrouped legacy campaigns have no shared-capacity boundary.
      rolloutGroupSentLastHour: c.rolloutGroupId
        ? rolloutCapacityByGroup.get(c.rolloutGroupId) ?? 0
        : 0,
      copyVersion: c.copyVersion,
      eligibilityPolicyVersion: c.eligibilityPolicyVersion,
      sourceDataCutoff: c.sourceDataCutoff.toISOString(),
      selectionLimit: c.selectionLimit,
      westernOnly: c.westernOnly,
      holdoutPercent: c.holdoutPercent,
      inboundWindowHours: c.inboundWindowHours,
      completionWindowHours: c.completionWindowHours,
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
  asOf: z.string().datetime().transform((value) => new Date(value)).optional(),
}).superRefine(({ cursor, asOf }, context) => {
  if (Boolean(cursor) !== Boolean(asOf)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cursor_and_asOf_must_be_provided_together" });
  }
});

/** Candidate list for one view, with the counts every tab badge reads from. */
historicalRecoveryRouter.get("/candidates", async (req, res) => {
  const requestNow = new Date();
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", detail: parsed.error.flatten() });
    return;
  }
  const { campaignId, view, limit, cursor, asOf } = parsed.data;
  if (asOf && asOf > requestNow) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const paginationAsOf = asOf ?? requestNow;

  const base: Prisma.RecoveryCandidateWhereInput = {
    ...(campaignId ? { campaignId } : {}),
    // Candidate selection is append-only, so pinning its creation boundary keeps
    // an in-progress pagination run from gaining newly selected rows on page two.
    createdAt: { lte: paginationAsOf },
  };
  const boundedRecoveredIds = await listBoundedRecoveredCandidateIds(campaignId, paginationAsOf);
  const where: Prisma.RecoveryCandidateWhereInput = {
    ...base,
    ...candidateViewWhere(view),
    ...(view === "recovered" ? { id: { in: boundedRecoveredIds } } : {}),
  };

  const rows = await prisma.recoveryCandidate.findMany({
    where,
    orderBy: [{ commentAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      campaign: { select: { startedAt: true } },
      sources: {
        orderBy: { position: "asc" },
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
      if (v === "recovered") {
        counts[v] = boundedRecoveredIds.length;
        return;
      }
      counts[v] = await prisma.recoveryCandidate.count({
        where: { ...base, ...candidateViewWhere(v) },
      });
    }),
  );

  res.json({
    counts,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    // The first response establishes this query's boundary; cursor requests echo
    // the validated value so a client never mixes pages from different reads.
    asOf: paginationAsOf.toISOString(),
    candidates: page.map((r) => {
      const observation = buildHistoricalAttributionObservation({
        ...r,
        campaignStartedAt: r.campaign.startedAt,
      });
      return {
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
        selectionPosition: r.selectionPosition,
        sourceChoiceReason: r.sourceChoiceReason,
        dispatchCommentId: r.dispatchCommentId,
        approvedSources: r.sources.map((source) => ({
          ...source,
          receivedAt: source.receivedAt.toISOString(),
        })),
        arm: r.arm,
        outcome: r.outcome,
        // The snapshot, not the live verdict: this is what the filter believed when
        // the campaign was approved, which is what an audit needs.
        audienceOrigin: r.audienceOrigin,
        audienceOriginMethod: r.audienceOriginMethod,
        audienceOriginConfidence: r.audienceOriginConfidence,
        audienceSegment: r.audienceSegment,
        currentAudienceSegment: usersById[r.igUserId]?.audienceSegment ?? null,
        sentAt: r.sentAt?.toISOString() ?? null,
        publicReplyId: r.publicReplyId,
        suppressionReason: r.suppressionReason,
        laterInboundAt: r.laterInboundAt?.toISOString() ?? null,
        laterCompletedAt: r.laterCompletedAt?.toISOString() ?? null,
        attributionAnchorAt: observation.anchorAt?.toISOString() ?? null,
        inboundWithin24Hours: observation.inboundWithin24Hours,
        completedWithin48Hours: observation.completedWithin48Hours,
      };
    }),
  });
});

/** Full immutable candidate evidence plus the current audience classification. */
historicalRecoveryRouter.get("/candidates/:id", async (req, res, next) => {
  const candidateId = z.string().uuid().safeParse(req.params.id);
  if (!candidateId.success) {
    res.status(400).json({ error: "invalid_candidate_id" });
    return;
  }
  try {
    const detail = await historicalCandidateDetail(candidateId.data);
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

historicalRecoveryRouter.post("/candidates/:id/mark-reviewed", async (req, res, next) => {
  const candidateId = z.string().uuid().safeParse(req.params.id);
  if (!candidateId.success) {
    res.status(400).json({ error: "invalid_candidate_id" });
    return;
  }

  try {
    const result = await markHistoricalCandidateReviewed({
      candidateId: candidateId.data,
      actor: req.adminEmail ?? null,
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (result.kind === "reviewed" || result.kind === "already_reviewed") {
      res.status(204).end();
      return;
    }
    res.status(409).json({ error: "conflict", outcome: result.outcome });
  } catch (error) {
    next(error);
  }
});

const approveBody = z.object({
  approvedBy: z.string().min(1).max(120),
  startPaused: z.boolean().optional().default(false),
});

/**
 * Approve a campaign, optionally leaving it paused while launch caps are staged.
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

  const result = await approveCampaign(
    req.params.id,
    body.data.approvedBy,
    new Date(),
    { startPaused: body.data.startPaused },
  );
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

const groupPauseParams = z.object({ id: z.string().uuid() });
const groupPauseBody = z.object({ reason: z.string().trim().min(1).max(200) });

/** Owner emergency stop for every running campaign in one expanded rollout. */
historicalRecoveryRouter.post("/rollout-groups/:id/pause", async (req, res, next) => {
  const params = groupPauseParams.safeParse(req.params);
  const body = groupPauseBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "invalid_group_pause" });
    return;
  }

  try {
    const result = await pauseCampaignGroup(params.data.id, body.data.reason, new Date());
    res.json(result);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "campaign_group_not_found"
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    next(error);
  }
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

const manualHealthObservationBody = z.object({
  kind: z.enum(["complaint", "block", "classifier_anomaly"]),
  sourceKey: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime(),
  safeDetail: z.string().trim().min(1).max(200).optional(),
});

/** Ingest externally verified, bounded safety evidence. */
historicalRecoveryRouter.post("/campaigns/:id/health-observations", async (req, res) => {
  if (!req.adminEmail) {
    res.status(401).json({ error: "owner_auth_required" });
    return;
  }
  const campaignId = z.string().uuid().safeParse(req.params.id);
  const body = manualHealthObservationBody.safeParse(req.body);
  if (!campaignId.success || !body.success) {
    res.status(400).json({ error: "invalid_health_observation" });
    return;
  }

  const input = {
    campaignId: campaignId.data,
    kind: body.data.kind,
    sourceKey: body.data.sourceKey,
    observedAt: new Date(body.data.observedAt),
    safeDetail: body.data.safeDetail,
  };
  const result = await recordCampaignHealthObservation(input);
  await logEvent("historical_campaign_health_observation_ingested", {
    campaignId: input.campaignId,
    kind: input.kind,
    sourceKey: input.sourceKey,
    safeDetail: input.safeDetail,
    actor: req.adminEmail,
    created: result.created,
  });
  res.json(result);
});
