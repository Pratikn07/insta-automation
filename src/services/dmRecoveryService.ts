import type { DmRecoveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import {
  assignRecoveryCohort,
  renderRecoveryCopy,
  RECOVERY_TEMPLATE_VERSION,
} from "./dmRecoveryPolicy.js";

// ── Input types ──────────────────────────────────────────────────────────

export type AcceptedGateRecoveryInput = {
  conversationId: string;
  igUserId: string;
  keywordId: string;
  keywordSnapshot: string;
  commentId: string;
  mediaId: string | null;
  gateDmMessageId: string | null;
  instagramGateMessageId: string | null;
  acceptedAt: Date;
};

export type SettingsBlockedRecoveryInput = {
  conversationId: string;
  igUserId: string;
  keywordId: string;
  keywordSnapshot: string;
  commentId: string;
  mediaId: string | null;
  rejectedAt: Date;
};

export type TrackingUnavailableRecoveryInput = {
  conversationId: string;
  igUserId: string;
  keywordId: string;
  keywordSnapshot: string;
  commentId: string;
  mediaId: string | null;
  /** When the untrackable outcome was observed. */
  observedAt: Date;
};

export type MessageCorrelatedEvidence = {
  instagramMessageId: string;
  eventAt: Date;
  receivedAt: Date;
};

export type PersonEvidence = {
  igUserId: string;
  eventAt: Date;
  receivedAt: Date;
};

// ── Guards ───────────────────────────────────────────────────────────────

/**
 * Recovery is comment-origin only. The public reply is posted on the source
 * comment, so a journey that began in the DMs has nowhere to post — such a
 * request must be rejected rather than persisted with a blank comment id,
 * which would also collide on the unique `comment_id` index.
 */
function requireCommentOrigin(commentId: string | null | undefined): string {
  const trimmed = commentId?.trim() ?? "";
  if (!trimmed) {
    throw new Error(
      "invalid_comment_origin: commentId is required — recovery is comment-origin only",
    );
  }
  return trimmed;
}

// ── Experiment / cohort assignment ───────────────────────────────────────

type CohortDecision = {
  status: DmRecoveryStatus;
  cohort: "treatment" | "control" | "not_applicable";
  lastErrorCategory: string | null;
};

function decideExperimentCohort(
  igUserId: string,
  acceptedAt: Date,
): CohortDecision {
  const startRaw = env.DM_RECOVERY_EXPERIMENT_START_AT;
  const endRaw = env.DM_RECOVERY_EXPERIMENT_END_AT;

  if (!startRaw || !endRaw) {
    return {
      status: "control",
      cohort: "control",
      lastErrorCategory: "experiment_not_configured",
    };
  }

  const experimentStart = new Date(startRaw);
  const experimentEnd = new Date(endRaw);

  if (acceptedAt.getTime() < experimentStart.getTime()) {
    return {
      status: "control",
      cohort: "control",
      lastErrorCategory: "experiment_not_started",
    };
  }

  if (acceptedAt.getTime() >= experimentEnd.getTime()) {
    if (!env.DM_RECOVERY_POST_EXPERIMENT_ENABLED) {
      return {
        status: "control",
        cohort: "control",
        lastErrorCategory: "experiment_awaiting_review",
      };
    }
    // Post-experiment enabled: use normal assignment for newly created rows.
  }

  // Inside window, or post-experiment with flag enabled.
  const cohort = assignRecoveryCohort(
    igUserId,
    env.DM_RECOVERY_EXPERIMENT_VERSION,
    env.DM_RECOVERY_HOLDOUT_PERCENT,
  );

  return {
    status: cohort === "control" ? "control" : "waiting",
    cohort,
    lastErrorCategory: null,
  };
}

/**
 * Statuses whose rows still carry meaning for the experiment.
 *
 * `waiting` transitions to `suppressed` on evidence; `control`, `sending` and
 * `sent` keep their status so a late webhook can still be measured. Everything
 * else is finished — a suppressed, failed, uncertain, untrackable or
 * owner-cancelled row must not be annotated after the fact, and scoping the
 * query this way also stops one inbound webhook rewriting a person's entire
 * recovery history.
 */
const EVIDENCE_ELIGIBLE_STATUSES = ["waiting", "control", "sending", "sent"] as const;

// ── Creation functions ───────────────────────────────────────────────────

export async function scheduleAcceptedGateRecovery(
  input: AcceptedGateRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }> {
  const commentId = requireCommentOrigin(input.commentId);

  // A null instagramGateMessageId means we can never correlate read receipts.
  if (!input.instagramGateMessageId) {
    return scheduleTrackingUnavailableRecovery({
      conversationId: input.conversationId,
      igUserId: input.igUserId,
      keywordId: input.keywordId,
      keywordSnapshot: input.keywordSnapshot,
      commentId,
      mediaId: input.mediaId,
      observedAt: input.acceptedAt,
    });
  }

  const { status, cohort, lastErrorCategory } = decideExperimentCohort(
    input.igUserId,
    input.acceptedAt,
  );

  const delayMs = env.DM_RECOVERY_DELAY_HOURS * 60 * 60 * 1000;
  const eligibleAt = new Date(input.acceptedAt.getTime() + delayMs);
  const publicReplyText = renderRecoveryCopy("no_confirmed_read", input.keywordSnapshot);

  const createData = {
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    templateVersion: RECOVERY_TEMPLATE_VERSION,
    publicReplyText,
    commentId,
    mediaId: input.mediaId,
    gateDmMessageId: input.gateDmMessageId,
    instagramGateMessageId: input.instagramGateMessageId,
    triggerKind: "no_confirmed_read" as const,
    status,
    cohort,
    acceptedAt: input.acceptedAt,
    eligibleAt,
    lastErrorCategory,
  };

  const row = await prisma.dmRecoveryReminder.upsert({
    where: { commentId },
    create: createData,
    update: {},
  });

  logger.info(
    {
      eventCode: "dm_recovery_created",
      id: row.id,
      triggerKind: row.triggerKind,
      status: row.status,
      cohort: row.cohort,
    },
    "Recovery reminder created",
  );

  // Withheld rows are the experiment's counterfactual, so record why this
  // person was held back — assignment is deterministic and never revisited.
  if (row.cohort === "control") {
    logger.info(
      {
        eventCode: "dm_recovery_control_assigned",
        id: row.id,
        reason: row.lastErrorCategory ?? "holdout",
        experimentVersion: env.DM_RECOVERY_EXPERIMENT_VERSION,
      },
      "Recovery reminder withheld as control",
    );
  }

  return { id: row.id, status: row.status };
}

export async function scheduleSettingsBlockedRecovery(
  input: SettingsBlockedRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }> {
  const commentId = requireCommentOrigin(input.commentId);
  const publicReplyText = renderRecoveryCopy("settings_blocked", input.keywordSnapshot);

  const createData = {
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    templateVersion: RECOVERY_TEMPLATE_VERSION,
    publicReplyText,
    commentId,
    mediaId: input.mediaId,
    gateDmMessageId: null,
    instagramGateMessageId: null,
    triggerKind: "settings_blocked" as const,
    status: "waiting" as const,
    cohort: "not_applicable" as const,
    acceptedAt: null,
    eligibleAt: input.rejectedAt,
    lastErrorCategory: null,
  };

  const row = await prisma.dmRecoveryReminder.upsert({
    where: { commentId },
    create: createData,
    update: {},
  });

  logger.info(
    {
      eventCode: "dm_recovery_created",
      id: row.id,
      triggerKind: row.triggerKind,
      status: row.status,
      cohort: row.cohort,
    },
    "Recovery reminder created (settings blocked)",
  );

  return { id: row.id, status: row.status };
}

export async function scheduleTrackingUnavailableRecovery(
  input: TrackingUnavailableRecoveryInput,
): Promise<{ id: string; status: "tracking_unavailable" }> {
  const commentId = requireCommentOrigin(input.commentId);
  const publicReplyText = renderRecoveryCopy("no_confirmed_read", input.keywordSnapshot);

  const createData = {
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    templateVersion: RECOVERY_TEMPLATE_VERSION,
    publicReplyText,
    commentId,
    mediaId: input.mediaId,
    gateDmMessageId: null,
    instagramGateMessageId: null,
    triggerKind: "no_confirmed_read" as const,
    status: "tracking_unavailable" as const,
    cohort: "not_applicable" as const,
    acceptedAt: null,
    // The status keeps this row away from the worker, which only ever selects
    // `waiting`. eligibleAt therefore records when the untrackable outcome was
    // observed, rather than a sentinel date the dashboard would render as one.
    eligibleAt: input.observedAt,
    lastErrorCategory: "private_send_outcome_unknown",
  };

  const row = await prisma.dmRecoveryReminder.upsert({
    where: { commentId },
    create: createData,
    update: {},
  });

  logger.info(
    {
      eventCode: "dm_recovery_tracking_unavailable",
      id: row.id,
      commentId,
    },
    "Recovery reminder created (tracking unavailable)",
  );

  return { id: row.id, status: "tracking_unavailable" };
}

// ── Evidence ingestion ───────────────────────────────────────────────────

/**
 * Record that the gate DM was seen. Correlates by Instagram message ID.
 * Only `waiting` rows transition to `suppressed`; other statuses preserve
 * their state for late-signal measurement.
 */
export async function recordRecoverySeen(
  input: MessageCorrelatedEvidence,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.dmRecoveryReminder.findMany({
        where: {
          instagramGateMessageId: input.instagramMessageId,
          status: { in: [...EVIDENCE_ELIGIBLE_STATUSES] },
        },
      });

      for (const row of rows) {
        const seenAt = earlierOf(row.seenAt, input.eventAt);
        const seenReceivedAt = earlierOf(row.seenReceivedAt, input.receivedAt);

        const statusUpdate =
          row.status === "waiting"
            ? {
                status: "suppressed" as const,
                suppressedAt: new Date(),
                suppressionReason: "seen",
              }
            : {};

        await tx.dmRecoveryReminder.update({
          where: { id: row.id },
          data: { seenAt, seenReceivedAt, ...statusUpdate },
        });

        logger.info(
          {
            eventCode: "dm_recovery_evidence_recorded",
            id: row.id,
            evidenceKind: "seen",
            previousStatus: row.status,
            newStatus: statusUpdate.status ?? row.status,
          },
          "Recovery seen evidence recorded",
        );
      }
    });
  } catch (err) {
    logger.error(
      {
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: "seen",
        instagramMessageId: input.instagramMessageId,
      },
      "Failed to record recovery seen evidence",
    );
  }
}

/**
 * Record a reaction to the gate DM. Correlates by Instagram message ID.
 */
export async function recordRecoveryReaction(
  input: MessageCorrelatedEvidence,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.dmRecoveryReminder.findMany({
        where: {
          instagramGateMessageId: input.instagramMessageId,
          status: { in: [...EVIDENCE_ELIGIBLE_STATUSES] },
        },
      });

      for (const row of rows) {
        const reactedAt = earlierOf(row.reactedAt, input.eventAt);

        const statusUpdate =
          row.status === "waiting"
            ? {
                status: "suppressed" as const,
                suppressedAt: new Date(),
                suppressionReason: "reaction",
              }
            : {};

        await tx.dmRecoveryReminder.update({
          where: { id: row.id },
          data: { reactedAt, ...statusUpdate },
        });

        logger.info(
          {
            eventCode: "dm_recovery_evidence_recorded",
            id: row.id,
            evidenceKind: "reaction",
            previousStatus: row.status,
            newStatus: statusUpdate.status ?? row.status,
          },
          "Recovery reaction evidence recorded",
        );
      }
    });
  } catch {
    logger.error(
      {
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: "reaction",
        instagramMessageId: input.instagramMessageId,
      },
      "Failed to record recovery reaction evidence",
    );
  }
}

/**
 * Record a postback (e.g. ice-breaker tap). Correlates by Instagram message ID.
 */
export async function recordRecoveryPostback(
  input: MessageCorrelatedEvidence,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.dmRecoveryReminder.findMany({
        where: {
          instagramGateMessageId: input.instagramMessageId,
          status: { in: [...EVIDENCE_ELIGIBLE_STATUSES] },
        },
      });

      for (const row of rows) {
        const postbackAt = earlierOf(row.postbackAt, input.eventAt);

        const statusUpdate =
          row.status === "waiting"
            ? {
                status: "suppressed" as const,
                suppressedAt: new Date(),
                suppressionReason: "postback",
              }
            : {};

        await tx.dmRecoveryReminder.update({
          where: { id: row.id },
          data: { postbackAt, ...statusUpdate },
        });

        logger.info(
          {
            eventCode: "dm_recovery_evidence_recorded",
            id: row.id,
            evidenceKind: "postback",
            previousStatus: row.status,
            newStatus: statusUpdate.status ?? row.status,
          },
          "Recovery postback evidence recorded",
        );
      }
    });
  } catch {
    logger.error(
      {
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: "postback",
        instagramMessageId: input.instagramMessageId,
      },
      "Failed to record recovery postback evidence",
    );
  }
}

/**
 * Record an inbound user message/attachment/quick-reply.
 *
 * Unlike message-correlated evidence, inbound engagement proves the user opened
 * a conversation with the business — so it suppresses ALL unfinished recovery
 * rows for the same `igUserId`.
 */
export async function recordRecoveryInbound(
  input: PersonEvidence & { kind: "inbound_reply" | "quick_reply" | "attachment" },
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.dmRecoveryReminder.findMany({
        where: {
          igUserId: input.igUserId,
          status: { in: [...EVIDENCE_ELIGIBLE_STATUSES] },
        },
      });

      for (const row of rows) {
        const repliedAt = earlierOf(row.repliedAt, input.eventAt);
        const repliedReceivedAt = earlierOf(row.repliedReceivedAt, input.receivedAt);
        const engagedAt = earlierOf(row.engagedAt, input.eventAt);
        const engagedReceivedAt = earlierOf(row.engagedReceivedAt, input.receivedAt);
        const firstEngagementKind = row.firstEngagementKind ?? input.kind;

        const statusUpdate =
          row.status === "waiting"
            ? {
                status: "suppressed" as const,
                suppressedAt: new Date(),
                suppressionReason: input.kind,
              }
            : {};

        await tx.dmRecoveryReminder.update({
          where: { id: row.id },
          data: {
            repliedAt,
            repliedReceivedAt,
            engagedAt,
            engagedReceivedAt,
            firstEngagementKind,
            ...statusUpdate,
          },
        });

        logger.info(
          {
            eventCode: "dm_recovery_evidence_recorded",
            id: row.id,
            evidenceKind: input.kind,
            previousStatus: row.status,
            newStatus: statusUpdate.status ?? row.status,
          },
          "Recovery inbound evidence recorded",
        );
      }
    });
  } catch {
    logger.error(
      {
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: input.kind,
        igUserId: input.igUserId,
      },
      "Failed to record recovery inbound evidence",
    );
  }
}

// ── Completion suppression ────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";

export async function suppressRecoveriesForCompletion(
  tx: Prisma.TransactionClient,
  input: { conversationId: string; igUserId: string; keywordId: string; completedAt: Date },
): Promise<void> {
  const { conversationId, igUserId, keywordId, completedAt } = input;

  // Bulk statements only. This runs inside the completion transaction, so a
  // read-then-update-per-row loop would hold that transaction open in
  // proportion to the person's history.
  //
  // `sending` is deliberately absent: a row mid-send must not be forced
  // terminal here. The worker's final pre-send transaction re-reads the
  // conversation and suppresses it there, which is the only point that can
  // safely decide the outcome of an in-flight send.
  const sourceWhere = { conversationId, status: "waiting" as const };
  const elsewhereWhere = {
    igUserId,
    keywordId,
    conversationId: { not: conversationId },
    status: "waiting" as const,
  };

  await tx.dmRecoveryReminder.updateMany({
    where: sourceWhere,
    data: {
      status: "suppressed",
      suppressedAt: completedAt,
      suppressionReason: "completed",
    },
  });

  await tx.dmRecoveryReminder.updateMany({
    where: elsewhereWhere,
    data: {
      status: "suppressed",
      suppressedAt: completedAt,
      suppressionReason: "completed_elsewhere",
    },
  });

  // Control rows are the experiment's counterfactual: record that the person
  // completed anyway, but never move them out of the holdout.
  await tx.dmRecoveryReminder.updateMany({
    where: { ...sourceWhere, status: "control" },
    data: { suppressedAt: completedAt, suppressionReason: "completed" },
  });

  await tx.dmRecoveryReminder.updateMany({
    where: { ...elsewhereWhere, status: "control" },
    data: { suppressedAt: completedAt, suppressionReason: "completed_elsewhere" },
  });

  logger.info(
    {
      eventCode: "dm_recovery_evidence_recorded",
      evidenceKind: "completion",
      conversationId,
      igUserId,
      keywordId,
    },
    "Recovery suppressed on journey completion",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function earlierOf(existing: Date | null, candidate: Date): Date {
  if (!existing) return candidate;
  return existing.getTime() <= candidate.getTime() ? existing : candidate;
}
