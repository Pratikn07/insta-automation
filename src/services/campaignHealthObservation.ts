import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logEvent } from "./eventLogger.js";
import {
  lockCampaignGroupMembers,
  lockRecoveryCampaignControl,
  pauseLockedCampaignGroup,
} from "./recoveryCampaignControl.js";

export type CampaignHealthSignal =
  | "complaint"
  | "opt_out"
  | "block"
  | "negative_reply"
  | "classifier_anomaly";

const SIGNALS: ReadonlySet<string> = new Set<CampaignHealthSignal>([
  "complaint",
  "opt_out",
  "block",
  "negative_reply",
  "classifier_anomaly",
]);

const OPT_OUT_MESSAGES = new Set([
  "stop",
  "unsubscribe",
  "unsubscribe please",
  "please unsubscribe",
  "do not contact me",
  "don't contact me",
  "do not message me",
  "don't message me",
  "stop messaging me",
  "remove me",
]);

const NEGATIVE_REPLY_MESSAGES = new Set([
  "leave me alone",
  "please leave me alone",
  "go away",
  "not interested",
]);

function normalizeWholeMessage(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

/** Conservative exact-message classifier. Substrings never count as evidence. */
export function classifyInboundHealthSignal(
  text: string,
): "opt_out" | "negative_reply" | null {
  const normalized = normalizeWholeMessage(text);
  if (OPT_OUT_MESSAGES.has(normalized)) return "opt_out";
  if (NEGATIVE_REPLY_MESSAGES.has(normalized)) return "negative_reply";
  return null;
}

/** Idempotently append one bounded, non-message health observation. */
export async function recordCampaignHealthObservation(input: {
  campaignId: string;
  kind: CampaignHealthSignal;
  sourceKey: string;
  observedAt: Date;
  safeDetail?: string;
}): Promise<{ created: boolean }> {
  const sourceKey = input.sourceKey.trim();
  const safeDetail = input.safeDetail?.trim();
  if (!SIGNALS.has(input.kind)) throw new Error("invalid_campaign_health_kind");
  if (!sourceKey || sourceKey.length > 200) throw new Error("invalid_campaign_health_source_key");
  if (safeDetail !== undefined && (!safeDetail || safeDetail.length > 200)) {
    throw new Error("invalid_campaign_health_safe_detail");
  }
  if (!Number.isFinite(input.observedAt.getTime())) {
    throw new Error("invalid_campaign_health_observed_at");
  }

  const result = await prisma.$transaction(async (tx) => {
    // Every health/group/dispatch path owns this singleton before any campaign row.
    // That serialization makes the required target-first identity read safe: although
    // the later group lock is ordered by ID, another serialized path cannot hold a
    // sibling and wait for this target, so the apparent target/group inversion cannot
    // form a deadlock cycle.
    await lockRecoveryCampaignControl(tx);
    const [target] = await tx.$queryRaw<Array<{ id: string; rolloutGroupId: string | null }>>`
      SELECT "id", "rollout_group_id" AS "rolloutGroupId"
      FROM "recovery_campaign"
      WHERE "id" = ${input.campaignId}::uuid
      FOR UPDATE
    `;
    const groupMembers = target?.rolloutGroupId
      ? await lockCampaignGroupMembers(tx, target.rolloutGroupId)
      : null;

    const inserted = await tx.recoveryCampaignHealthObservation.createMany({
      data: [{
        campaignId: input.campaignId,
        kind: input.kind,
        sourceKey,
        observedAt: input.observedAt,
        safeDetail,
      }],
      skipDuplicates: true,
    });

    let legacyPaused = false;
    if (inserted.count === 1 && target?.rolloutGroupId && groupMembers) {
      await pauseLockedCampaignGroup(
        tx,
        target.rolloutGroupId,
        groupMembers,
        `auto:${input.kind}`,
        input.observedAt,
      );
    } else if (inserted.count === 1) {
      const paused = await tx.recoveryCampaign.updateMany({
        where: { id: input.campaignId, state: "running" },
        data: {
          state: "paused",
          pausedAt: input.observedAt,
          pauseReason: `auto:${input.kind}`,
        },
      });
      legacyPaused = paused.count === 1;
    }

    return { created: inserted.count === 1, legacyPaused };
  });

  if (result.legacyPaused) {
    await logEvent("historical_campaign_auto_paused", {
      campaignId: input.campaignId,
      reason: input.kind,
      source: "durable_health_observation",
    });
  }
  return { created: result.created };
}

/** Promote a newly persisted inbound provider message to campaign health evidence. */
export async function recordInboundCampaignHealthSignals(input: {
  igUserId: string;
  instagramMessageId: string;
  text: string;
  observedAt: Date;
}): Promise<{ recorded: number }> {
  const kind = classifyInboundHealthSignal(input.text);
  if (!kind) return { recorded: 0 };

  const cutoff = new Date(input.observedAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dispatches = await prisma.publicRecoveryDispatch.findMany({
    where: {
      igUserId: input.igUserId,
      sourceKind: "historical",
      campaignId: { not: null },
      // Reserved work has no dispatchStartedAt by definition. Attribute against the
      // timestamp that makes each state true so an opt-out in the reserve/start gap
      // cannot be classified as unrelated and then marked captured.
      OR: [
        {
          state: "reserved",
          reservedAt: { gt: cutoff, lte: input.observedAt },
        },
        {
          state: { in: ["dispatch_started", "sent", "uncertain"] },
          dispatchStartedAt: { gt: cutoff, lte: input.observedAt },
        },
      ],
    },
    select: { campaignId: true },
    distinct: ["campaignId"],
  });

  let recorded = 0;
  for (const dispatch of dispatches) {
    if (!dispatch.campaignId) continue;
    const result = await recordCampaignHealthObservation({
      campaignId: dispatch.campaignId,
      kind,
      sourceKey: `inbound:${input.instagramMessageId}`,
      observedAt: input.observedAt,
    });
    if (result.created) recorded++;
  }
  return { recorded };
}

/** Mark the durable inbound safety inbox row only after classification succeeds. */
export async function markInboundCampaignHealthCaptured(
  messageId: string,
  capturedAt = new Date(),
): Promise<boolean> {
  const result = await prisma.dmMessage.updateMany({
    where: {
      id: messageId,
      direction: "inbound",
      campaignHealthCapturedAt: null,
    },
    data: {
      campaignHealthCapturedAt: capturedAt,
      campaignHealthCaptureAttempts: { increment: 1 },
      campaignHealthNextAttemptAt: null,
      campaignHealthLastError: null,
    },
  });
  if (result.count === 1) return true;

  const existing = await prisma.dmMessage.findFirst({
    where: { id: messageId, direction: "inbound", campaignHealthCapturedAt: { not: null } },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Drain durable inbound health capture before a historical campaign may dispatch.
 *
 * The HTTP webhook is acknowledged before handlers run, so this row-level inbox—not a
 * provider retry—is the recovery mechanism. Any failed or undiscovered row makes the
 * historical tick fail closed; a later tick retries with bounded backoff.
 */
export async function reconcilePendingInboundCampaignHealthSignals(
  now = new Date(),
  limit = 100,
): Promise<{ processed: number; failed: number; remaining: boolean }> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid_health_capture_limit");

  const due = await prisma.dmMessage.findMany({
    where: {
      direction: "inbound",
      instagramMessageId: { not: null },
      campaignHealthCapturedAt: null,
      OR: [
        { campaignHealthNextAttemptAt: null },
        { campaignHealthNextAttemptAt: { lte: now } },
      ],
    },
    select: {
      id: true,
      instagramMessageId: true,
      text: true,
      instagramTimestamp: true,
      thread: { select: { igUserId: true } },
    },
    orderBy: [{ instagramTimestamp: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  let processed = 0;
  let failed = 0;
  for (const message of due.slice(0, limit)) {
    try {
      await recordInboundCampaignHealthSignals({
        igUserId: message.thread.igUserId,
        instagramMessageId: message.instagramMessageId!,
        text: message.text ?? "",
        observedAt: message.instagramTimestamp,
      });
      await markInboundCampaignHealthCaptured(message.id, now);
      processed++;
    } catch {
      failed++;
      await prisma.dmMessage.updateMany({
        where: { id: message.id, campaignHealthCapturedAt: null },
        data: {
          campaignHealthCaptureAttempts: { increment: 1 },
          campaignHealthNextAttemptAt: new Date(now.getTime() + 5 * 60_000),
          campaignHealthLastError: "capture_failed",
        },
      });
      logger.error(
        { errorCode: "campaign_health_inbound_reconcile_failed", messageId: message.id },
        "Could not reconcile durable inbound campaign health evidence",
      );
    }
  }

  const pending = due.length > limit
    ? true
    : (await prisma.dmMessage.findFirst({
        where: {
          direction: "inbound",
          instagramMessageId: { not: null },
          campaignHealthCapturedAt: null,
        },
        select: { id: true },
      })) !== null;

  return { processed, failed, remaining: pending };
}
