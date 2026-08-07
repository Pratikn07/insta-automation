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

// ── Creation functions ───────────────────────────────────────────────────

export async function scheduleAcceptedGateRecovery(
  input: AcceptedGateRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }> {
  // A null instagramGateMessageId means we can never correlate read receipts.
  if (!input.instagramGateMessageId) {
    return scheduleTrackingUnavailableRecovery({
      conversationId: input.conversationId,
      igUserId: input.igUserId,
      keywordId: input.keywordId,
      keywordSnapshot: input.keywordSnapshot,
      commentId: input.commentId,
      mediaId: input.mediaId,
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
    commentId: input.commentId,
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
    where: { commentId: input.commentId },
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

  return { id: row.id, status: row.status };
}

export async function scheduleSettingsBlockedRecovery(
  input: SettingsBlockedRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }> {
  const publicReplyText = renderRecoveryCopy("settings_blocked", input.keywordSnapshot);

  const createData = {
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    templateVersion: RECOVERY_TEMPLATE_VERSION,
    publicReplyText,
    commentId: input.commentId,
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
    where: { commentId: input.commentId },
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
  const publicReplyText = renderRecoveryCopy("no_confirmed_read", input.keywordSnapshot);

  // Far-future eligibleAt ensures automatic worker never selects this.
  const farFuture = new Date("2099-12-31T23:59:59Z");

  const createData = {
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    templateVersion: RECOVERY_TEMPLATE_VERSION,
    publicReplyText,
    commentId: input.commentId,
    mediaId: input.mediaId,
    gateDmMessageId: null,
    instagramGateMessageId: null,
    triggerKind: "no_confirmed_read" as const,
    status: "tracking_unavailable" as const,
    cohort: "not_applicable" as const,
    acceptedAt: null,
    eligibleAt: farFuture,
    lastErrorCategory: "private_send_outcome_unknown",
  };

  const row = await prisma.dmRecoveryReminder.upsert({
    where: { commentId: input.commentId },
    create: createData,
    update: {},
  });

  logger.info(
    {
      eventCode: "dm_recovery_tracking_unavailable",
      id: row.id,
      commentId: input.commentId,
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
        where: { instagramGateMessageId: input.instagramMessageId },
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
        where: { instagramGateMessageId: input.instagramMessageId },
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
        where: { instagramGateMessageId: input.instagramMessageId },
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
        where: { igUserId: input.igUserId },
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
  const rows = await tx.dmRecoveryReminder.findMany({
    where: {
      OR: [
        { conversationId: input.conversationId },
        { igUserId: input.igUserId, keywordId: input.keywordId },
      ],
    },
  });

  for (const row of rows) {
    const isSourceConvo = row.conversationId === input.conversationId;
    const reason = isSourceConvo ? "completed" : "completed_elsewhere";

    if (row.status === "waiting") {
      await tx.dmRecoveryReminder.update({
        where: { id: row.id },
        data: {
          status: "suppressed",
          suppressedAt: input.completedAt,
          suppressionReason: reason,
        },
      });
      logger.info(
        {
          eventCode: "dm_recovery_evidence_recorded",
          id: row.id,
          evidenceKind: "completion",
          previousStatus: "waiting",
          newStatus: "suppressed",
          suppressionReason: reason,
        },
        "Recovery suppressed on journey completion",
      );
    } else if (row.status === "control") {
      // Record observed completion timestamp/reason on control rows for counterfactual analysis without changing cohort status
      await tx.dmRecoveryReminder.update({
        where: { id: row.id },
        data: {
          suppressedAt: input.completedAt,
          suppressionReason: reason,
        },
      });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function earlierOf(existing: Date | null, candidate: Date): Date {
  if (!existing) return candidate;
  return existing.getTime() <= candidate.getTime() ? existing : candidate;
}
