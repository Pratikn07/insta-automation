import type { DmRecoveryStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";
import { logger } from "../lib/logger.js";
import { recordRecoveryDatabaseFailure } from "./dmRecoveryHealth.js";
// One-directional: the repository does not import this module, so there is no
// cycle. Shared so the snapshot and the send-time check cannot disagree on how a
// verdict is read.
import { resolveAudienceOrigin } from "./dmRecoveryRepository.js";
import { env } from "../config/env.js";
import {
  assignRecoveryCohort,
  renderRecoveryCopy,
  RECOVERY_TEMPLATE_VERSION,
} from "./dmRecoveryPolicy.js";
import {
  assignRecoveryTimingArm,
  DM_RECOVERY_TIMING_EXPERIMENT_VERSION,
  timingScheduleForArm,
  type RecoveryTimingArm,
} from "./dmRecoveryTimingExperiment.js";
import {
  lockAndValidateSettingsBlockedVerificationEvidence,
  type SettingsBlockedVerificationEvidence,
} from "./settingsBlockedVerificationService.js";

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
  verification: SettingsBlockedVerificationEvidence;
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
    if (!flags.bool("DM_RECOVERY_POST_EXPERIMENT_ENABLED")) {
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
    flags.percent("DM_RECOVERY_HOLDOUT_PERCENT"),
  );

  return {
    status: cohort === "control" ? "control" : "waiting",
    cohort,
    lastErrorCategory: null,
  };
}

function acceptedInsideConfiguredWindow(acceptedAt: Date): boolean {
  const startRaw = env.DM_RECOVERY_EXPERIMENT_START_AT;
  const endRaw = env.DM_RECOVERY_EXPERIMENT_END_AT;
  if (!startRaw || !endRaw) return false;

  const acceptedTime = acceptedAt.getTime();
  return (
    acceptedTime >= new Date(startRaw).getTime() &&
    acceptedTime < new Date(endRaw).getTime()
  );
}

function excludedV2WindowDecision(acceptedAt: Date): CohortDecision {
  const startRaw = env.DM_RECOVERY_EXPERIMENT_START_AT;
  const endRaw = env.DM_RECOVERY_EXPERIMENT_END_AT;

  if (!startRaw || !endRaw) {
    return {
      status: "control",
      cohort: "control",
      lastErrorCategory: "experiment_not_configured",
    };
  }

  if (acceptedAt.getTime() < new Date(startRaw).getTime()) {
    return {
      status: "control",
      cohort: "control",
      lastErrorCategory: "experiment_not_started",
    };
  }

  return {
    status: "control",
    cohort: "control",
    lastErrorCategory: "experiment_awaiting_review",
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

  // Freeze the origin verdict onto the row. The send-time check reads ig_users
  // live, which is correct for deciding, but ig_users is rewritten continuously
  // and a verdict is retired when the name behind it changes — so the live value
  // cannot say afterwards which population a row belonged to.
  //
  // Control rows are why this matters. They are terminal at creation and never
  // reach the origin check, so without a snapshot the treatment arm is filtered
  // by market and the control arm is not. Comparing them then compares two
  // different populations and understates the reminder's effect.
  const audience = await readAudienceOriginSnapshot(input.igUserId);
  const isV2 =
    env.DM_RECOVERY_EXPERIMENT_VERSION ===
    DM_RECOVERY_TIMING_EXPERIMENT_VERSION;
  const insideWindow = acceptedInsideConfiguredWindow(input.acceptedAt);
  const inMarket =
    !env.DM_RECOVERY_WESTERN_ONLY || audience.origin !== "south_asian";
  const publicReplyText = renderRecoveryCopy("no_confirmed_read", input.keywordSnapshot);

  let status: DmRecoveryStatus;
  let cohort: "treatment" | "control" | "not_applicable";
  let eligibleAt: Date;
  let lastErrorCategory: string | null;
  let experimentVersionSnapshot: string | null = null;
  let timingArm: RecoveryTimingArm | null = null;
  let terminalSuppression: {
    suppressedAt: Date;
    suppressionReason: "audience_out_of_market";
  } | null = null;

  if (isV2 && insideWindow && inMarket) {
    timingArm = assignRecoveryTimingArm(input.igUserId);
    const schedule = timingScheduleForArm(timingArm, input.acceptedAt);
    status = schedule.status;
    cohort = schedule.cohort;
    eligibleAt = schedule.eligibleAt;
    lastErrorCategory = null;
    experimentVersionSnapshot = DM_RECOVERY_TIMING_EXPERIMENT_VERSION;
  } else if (isV2 && insideWindow) {
    status = "suppressed";
    cohort = "not_applicable";
    eligibleAt = new Date(input.acceptedAt.getTime());
    lastErrorCategory = null;
    terminalSuppression = {
      suppressedAt: input.acceptedAt,
      suppressionReason: "audience_out_of_market",
    };
  } else {
    // V2 reaches this branch only for a terminal pre/post-window exclusion. The
    // configurable delay and holdout below remain the live v1 behavior.
    const decision = isV2
      ? excludedV2WindowDecision(input.acceptedAt)
      : decideExperimentCohort(input.igUserId, input.acceptedAt);
    status = decision.status;
    cohort = decision.cohort;
    lastErrorCategory = decision.lastErrorCategory;
    const delayMs = env.DM_RECOVERY_DELAY_HOURS * 60 * 60 * 1_000;
    eligibleAt = new Date(input.acceptedAt.getTime() + delayMs);
  }

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
    experimentVersionSnapshot,
    timingArm,
    acceptedAt: input.acceptedAt,
    eligibleAt,
    lastErrorCategory,
    audienceOrigin: audience.origin,
    audienceOriginConfidence: audience.confidence,
    ...(terminalSuppression ?? {}),
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
      experimentVersion: row.experimentVersionSnapshot,
      timingArm: row.timingArm,
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
        experimentVersion: row.experimentVersionSnapshot,
        timingArm: row.timingArm,
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

  // An exact webhook/retry replay must preserve the evidence captured on the
  // original row even if the registry version was retired afterwards.
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
    experimentVersionSnapshot: null,
    timingArm: null,
    acceptedAt: null,
    eligibleAt: input.verification.classifiedAt,
    lastErrorCategory: null,
    settingsEvidenceLegacy: false,
    settingsVerificationId: input.verification.verificationId,
    settingsVerificationVersion: input.verification.verificationVersion,
    settingsGraphCode: input.verification.graphCode,
    settingsGraphSubcode: input.verification.graphSubcode,
    settingsClassifiedAt: input.verification.classifiedAt,
    settingsEvidenceReference: input.verification.evidenceReference,
    settingsEvidenceSha256: input.verification.evidenceSha256,
  };

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.dmRecoveryReminder.findUnique({
      where: { commentId },
      select: { id: true, status: true },
    });
    if (existing) return existing;

    await lockAndValidateSettingsBlockedVerificationEvidence(tx, input.verification);
    return tx.dmRecoveryReminder.upsert({
      where: { commentId },
      create: createData,
      update: {},
    });
  });

  logger.info(
    {
      eventCode: "dm_recovery_created",
      id: row.id,
      triggerKind: "settings_blocked",
      status: row.status,
      cohort: "not_applicable",
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
    experimentVersionSnapshot: null,
    timingArm: null,
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
  } catch {
    recordRecoveryDatabaseFailure();
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
        // The dedicated timestamp preserves the experiment denominator, but the
        // shared engagement fields are what the final pre-send authorization
        // reads. Writing only reactedAt let a reaction arriving during the lease
        // window fail to stop a public comment.
        const engagement = sharedEngagement(row, input, "reaction");

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
          data: { reactedAt, ...engagement, ...statusUpdate },
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
    recordRecoveryDatabaseFailure();
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
        const engagement = sharedEngagement(row, input, "postback");

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
          data: { postbackAt, ...engagement, ...statusUpdate },
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
    recordRecoveryDatabaseFailure();
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
    recordRecoveryDatabaseFailure();
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

/**
 * The audience-origin verdict as it stood when a reminder was created.
 *
 * Returns nulls rather than throwing: this is measurement, and a failed lookup
 * must never stop a reminder being recorded. A null reads as "not known at
 * creation" — which is also the honest value when the classifier has not reached
 * this person yet — and stays recoverable from ig_users later.
 */
async function readAudienceOriginSnapshot(
  igUserId: string,
): Promise<{ origin: string | null; confidence: string | null }> {
  try {
    const person = await prisma.igUser.findUnique({
      where: { id: igUserId },
      select: {
        username: true,
        name: true,
        inferredOrigin: true,
        originConfidence: true,
        originMethod: true,
      },
    });
    // Same resolver the send-time check uses, so the snapshot cannot disagree
    // with the decision for reasons other than elapsed time.
    const resolved = resolveAudienceOrigin(person);
    return { origin: resolved.origin, confidence: resolved.confidence };
  } catch {
    recordRecoveryDatabaseFailure();
    logger.error(
      { errorCode: "audience_origin_snapshot_failed", igUserId },
      "Could not snapshot audience origin; recording the reminder without it",
    );
    return { origin: null, confidence: null };
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

/**
 * Suppress on completion without letting the attempt escape as an exception.
 *
 * Call this from the completion path. `suppressRecoveriesForCompletion` itself
 * must not be run inside the caller's completion transaction: a failure there
 * rolls back the completion and the gate abandon, so the gate worker re-sends
 * "reply DONE to unlock" to someone who already has the guide.
 *
 * Dropping the suppression is the safe failure. The recovery worker re-runs the
 * full policy in its final pre-send transaction, where `conversationCompletedAt`
 * suppresses the row before any public comment is posted.
 */
export async function suppressRecoveriesForCompletionSafely(input: {
  conversationId: string;
  igUserId: string;
  keywordId: string;
  completedAt: Date;
}): Promise<void> {
  try {
    await prisma.$transaction((tx) => suppressRecoveriesForCompletion(tx, input));
  } catch {
    recordRecoveryDatabaseFailure();
    logger.error(
      {
        errorCode: "dm_recovery_completion_suppression_failed",
        conversationId: input.conversationId,
        igUserId: input.igUserId,
      },
      "Failed to suppress recovery on journey completion",
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * The engagement fields every consumer reads — the final pre-send check, the
 * policy, and the health signal sample. A recorder that writes only its own
 * dedicated timestamp is invisible to all three.
 */
function sharedEngagement(
  row: { engagedAt: Date | null; engagedReceivedAt: Date | null; firstEngagementKind: string | null },
  input: { eventAt: Date; receivedAt: Date },
  kind: string,
): { engagedAt: Date; engagedReceivedAt: Date; firstEngagementKind: string } {
  return {
    engagedAt: earlierOf(row.engagedAt, input.eventAt),
    engagedReceivedAt: earlierOf(row.engagedReceivedAt, input.receivedAt),
    firstEngagementKind: row.firstEngagementKind ?? kind,
  };
}

function earlierOf(existing: Date | null, candidate: Date): Date {
  if (!existing) return candidate;
  return existing.getTime() <= candidate.getTime() ? existing : candidate;
}
