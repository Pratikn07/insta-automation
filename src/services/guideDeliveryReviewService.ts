import { Prisma, type PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { guideDeliveryRepository } from "./guideDeliveryRepository.js";
import { processClaimedGuideDelivery } from "./guideDeliveryService.js";

export type GuideDeliveryReviewErrorCode =
  | "duplicate_risk_acknowledgement_required"
  | "delivery_not_found"
  | "unit_not_found"
  | "delivery_state_changed"
  | "messaging_window_closed";

export class GuideDeliveryReviewError extends Error {
  readonly code: GuideDeliveryReviewErrorCode;

  constructor(code: GuideDeliveryReviewErrorCode) {
    super(code);
    this.name = "GuideDeliveryReviewError";
    this.code = code;
  }
}

export type GuideDeliveryReviewResult = {
  status: "accepted" | "processing_started";
};

export type GuideDeliveryReviewDispatch = {
  deliveryId: string;
  directive: "finalize" | "resume";
  now: Date;
};

type ReviewDatabase = Pick<PrismaClient, "$transaction">;
type ReviewTransaction = Prisma.TransactionClient;

type LockedReviewDelivery = {
  id: string;
  conversationId: string;
  resourceId: string;
  triggerKind: "inbound_reply" | "explicit_redelivery" | "follow_recovery";
  triggerId: string;
  status: "planned" | "sending" | "failed" | "needs_review" | "completed" | "cancelled";
  failureCode: string | null;
  sendWindowExpiresAt: Date;
};

type LockedReviewUnit = {
  id: string;
  position: number;
  kind: "text" | "image" | "file";
  status: "pending" | "sending" | "sent" | "retryable" | "failed" | "uncertain" | "cancelled";
};

type ReviewTransition = {
  deliveryId: string;
  directive: "finalize" | "resume" | "none";
  rejection?: "messaging_window_closed";
};

type ReviewDependencies = {
  database?: ReviewDatabase;
  dispatchAfterCommit?: (dispatch: GuideDeliveryReviewDispatch) => Promise<void>;
};

type ReviewActionInput = {
  deliveryId: string;
  actor: string;
  now: Date;
};

type ReviewUnitActionInput = ReviewActionInput & {
  unitId: string;
};

function assertReviewInput(input: ReviewActionInput): void {
  if (!input.actor || !Number.isFinite(input.now.getTime())) {
    throw new GuideDeliveryReviewError("delivery_state_changed");
  }
}

async function lockDelivery(
  tx: ReviewTransaction,
  deliveryId: string,
): Promise<LockedReviewDelivery | null> {
  const rows = await tx.$queryRaw<LockedReviewDelivery[]>(Prisma.sql`
    SELECT
      delivery."id",
      delivery."conversation_id" AS "conversationId",
      delivery."resource_id" AS "resourceId",
      delivery."trigger_kind"::text AS "triggerKind",
      delivery."trigger_id" AS "triggerId",
      delivery."status"::text AS "status",
      delivery."failure_code" AS "failureCode",
      delivery."send_window_expires_at" AS "sendWindowExpiresAt"
    FROM "guide_delivery" AS delivery
    WHERE delivery."id" = ${deliveryId}::uuid
    FOR UPDATE OF delivery
  `);
  return rows[0] ?? null;
}

async function lockUnits(
  tx: ReviewTransaction,
  deliveryId: string,
): Promise<LockedReviewUnit[]> {
  return tx.$queryRaw<LockedReviewUnit[]>(Prisma.sql`
    SELECT
      unit."id",
      unit."position",
      unit."kind"::text AS "kind",
      unit."status"::text AS "status"
    FROM "guide_delivery_unit" AS unit
    WHERE unit."delivery_id" = ${deliveryId}::uuid
    ORDER BY unit."position" ASC
    FOR UPDATE OF unit
  `);
}

function requireUnit(units: readonly LockedReviewUnit[], unitId: string): LockedReviewUnit {
  const unit = units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new GuideDeliveryReviewError("unit_not_found");
  return unit;
}

function requireReviewableUnit(
  delivery: LockedReviewDelivery,
  unit: LockedReviewUnit,
): void {
  if (delivery.status !== "needs_review" || unit.status !== "uncertain") {
    throw new GuideDeliveryReviewError("delivery_state_changed");
  }
}

function ownerActionPayload(
  delivery: LockedReviewDelivery,
  input: { actor: string; action: string; unitId: string | null; now: Date },
): Prisma.InputJsonObject {
  return {
    actor: input.actor,
    action: input.action,
    deliveryId: delivery.id,
    resourceId: delivery.resourceId,
    unitId: input.unitId,
    at: input.now.toISOString(),
  };
}

async function writeOwnerAction(
  tx: ReviewTransaction,
  delivery: LockedReviewDelivery,
  input: { actor: string; action: string; unitId: string | null; now: Date },
): Promise<void> {
  await tx.eventLog.create({
    data: {
      kind: "guide_delivery_owner_action",
      payload: ownerActionPayload(delivery, input),
    },
  });
}

async function writeWindowClosed(
  tx: ReviewTransaction,
  delivery: LockedReviewDelivery,
  now: Date,
): Promise<void> {
  await tx.eventLog.create({
    data: {
      kind: "guide_delivery_window_closed",
      payload: {
        deliveryId: delivery.id,
        conversationId: delivery.conversationId,
        resourceId: delivery.resourceId,
        triggerKind: delivery.triggerKind,
        triggerId: delivery.triggerId,
        at: now.toISOString(),
      },
    },
  });
}

async function makeDeliveryProcessable(
  tx: ReviewTransaction,
  deliveryId: string,
  now: Date,
): Promise<void> {
  await tx.guideDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "planned",
      failureCode: null,
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      updatedAt: now,
    },
  });
}

async function defaultDispatchAfterCommit(dispatch: GuideDeliveryReviewDispatch): Promise<void> {
  const claimed = await guideDeliveryRepository.claimById({
    deliveryId: dispatch.deliveryId,
    now: dispatch.now,
    claimExpiresAt: new Date(dispatch.now.getTime() + env.GUIDE_DELIVERY_LEASE_MS),
  });
  if (!claimed) return;
  await processClaimedGuideDelivery(claimed);
}

export function createGuideDeliveryReviewService(dependencies: ReviewDependencies = {}) {
  const database = dependencies.database ?? prisma;
  const dispatchAfterCommit = dependencies.dispatchAfterCommit ?? defaultDispatchAfterCommit;

  async function finishTransition(transition: ReviewTransition, now: Date) {
    if (transition.directive === "none") return { status: "accepted" } as const;
    try {
      await dispatchAfterCommit({
        deliveryId: transition.deliveryId,
        directive: transition.directive,
        now,
      });
    } catch {
      logger.error(
        {
          errorCode: "guide_delivery_owner_dispatch_failed",
          deliveryId: transition.deliveryId,
          directive: transition.directive,
        },
        "Failed to continue an owner-reviewed guide delivery",
      );
    }
    return { status: "processing_started" } as const;
  }

  return {
    async confirmUnitDelivered(input: ReviewUnitActionInput): Promise<GuideDeliveryReviewResult> {
      assertReviewInput(input);
      const transition = await database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (!delivery) throw new GuideDeliveryReviewError("delivery_not_found");
        const units = await lockUnits(tx, input.deliveryId);
        const unit = requireUnit(units, input.unitId);
        requireReviewableUnit(delivery, unit);

        await tx.guideDeliveryUnit.update({
          where: { id: unit.id },
          data: {
            status: "sent",
            sentAt: input.now,
            ownerConfirmedAt: input.now,
            failureDisposition: null,
            errorCategory: null,
            errorHttpStatus: null,
            errorGraphCode: null,
            errorGraphSubcode: null,
            errorTraceId: null,
            errorTransportCode: null,
            updatedAt: input.now,
          },
        });
        await writeOwnerAction(tx, delivery, {
          actor: input.actor,
          action: "confirm_delivered",
          unitId: unit.id,
          now: input.now,
        });

        const allSent = units.every(
          (candidate) => candidate.id === unit.id || candidate.status === "sent",
        );
        if (allSent) {
          await makeDeliveryProcessable(tx, delivery.id, input.now);
          return { deliveryId: delivery.id, directive: "finalize" } as const;
        }
        if (delivery.sendWindowExpiresAt > input.now) {
          await makeDeliveryProcessable(tx, delivery.id, input.now);
          return { deliveryId: delivery.id, directive: "resume" } as const;
        }

        await tx.guideDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "failed",
            failureCode: "messaging_window_closed",
            nextAttemptAt: null,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: input.now,
          },
        });
        await writeWindowClosed(tx, delivery, input.now);
        return { deliveryId: delivery.id, directive: "none" } as const;
      });
      return finishTransition(transition, input.now);
    },

    async retryUncertainUnit(
      input: ReviewUnitActionInput & { acknowledgeDuplicateRisk: boolean },
    ): Promise<GuideDeliveryReviewResult> {
      if (input.acknowledgeDuplicateRisk !== true) {
        throw new GuideDeliveryReviewError("duplicate_risk_acknowledgement_required");
      }
      assertReviewInput(input);
      const transition: ReviewTransition = await database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (!delivery) throw new GuideDeliveryReviewError("delivery_not_found");
        const units = await lockUnits(tx, input.deliveryId);
        const unit = requireUnit(units, input.unitId);
        if (
          delivery.status === "failed" &&
          delivery.failureCode === "messaging_window_closed" &&
          unit.status === "uncertain"
        ) {
          return {
            deliveryId: delivery.id,
            directive: "none",
            rejection: "messaging_window_closed",
          };
        }
        requireReviewableUnit(delivery, unit);
        if (delivery.sendWindowExpiresAt <= input.now) {
          await tx.guideDelivery.update({
            where: { id: delivery.id },
            data: {
              status: "failed",
              failureCode: "messaging_window_closed",
              nextAttemptAt: null,
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
              updatedAt: input.now,
            },
          });
          await writeOwnerAction(tx, delivery, {
            actor: input.actor,
            action: "retry_skipped_window_closed",
            unitId: unit.id,
            now: input.now,
          });
          return {
            deliveryId: delivery.id,
            directive: "none",
            rejection: "messaging_window_closed",
          };
        }

        await tx.guideDeliveryUnit.update({
          where: { id: unit.id },
          data: {
            status: "retryable",
            sentAt: null,
            ownerConfirmedAt: null,
            failureDisposition: null,
            providerMessageId: null,
            errorCategory: null,
            errorHttpStatus: null,
            errorGraphCode: null,
            errorGraphSubcode: null,
            errorTraceId: null,
            errorTransportCode: null,
            ownerRetryAuthorizedAt: input.now,
            ownerRetryConsumedAt: null,
            updatedAt: input.now,
          },
        });
        await makeDeliveryProcessable(tx, delivery.id, input.now);
        await writeOwnerAction(tx, delivery, {
          actor: input.actor,
          action: "retry_uncertain",
          unitId: unit.id,
          now: input.now,
        });
        return { deliveryId: delivery.id, directive: "resume" } as const;
      });
      if (transition.rejection === "messaging_window_closed") {
        throw new GuideDeliveryReviewError(transition.rejection);
      }
      return finishTransition(transition, input.now);
    },

    async cancelGuideDelivery(input: ReviewActionInput): Promise<GuideDeliveryReviewResult> {
      assertReviewInput(input);
      await database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (!delivery) throw new GuideDeliveryReviewError("delivery_not_found");
        const units = await lockUnits(tx, input.deliveryId);
        if (delivery.status === "cancelled") return;
        const reviewableClosedFailure =
          delivery.status === "failed" && delivery.failureCode === "messaging_window_closed";
        if (delivery.status !== "needs_review" && !reviewableClosedFailure) {
          throw new GuideDeliveryReviewError("delivery_state_changed");
        }

        const nonSentIds = units
          .filter((unit) => unit.status !== "sent")
          .map((unit) => unit.id);
        if (nonSentIds.length > 0) {
          await tx.guideDeliveryUnit.updateMany({
            where: { id: { in: nonSentIds }, deliveryId: delivery.id, status: { not: "sent" } },
            data: {
              status: "cancelled",
              sentAt: null,
              ownerConfirmedAt: null,
              ownerRetryAuthorizedAt: null,
              ownerRetryConsumedAt: null,
              updatedAt: input.now,
            },
          });
        }
        await tx.guideDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "cancelled",
            nextAttemptAt: null,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            cancelledAt: input.now,
            updatedAt: input.now,
          },
        });
        // Release the guide-access attempt in the SAME transaction as the cancel.
        //
        // `delivering` is an ACTIVE attempt state, so a cancelled delivery that left the
        // attempt untouched would keep `createOrLoadAttempt` loading it and silently block
        // the parent's next request for the rest of the messaging window. `needs_review`
        // rather than `expired`: an owner cancelled this deliberately and should see it.
        // Fenced on `delivering` so a stale cancel cannot move an attempt that already
        // settled, and no new action token is invented.
        await tx.guideAccessAttempt.updateMany({
          where: { conversationId: delivery.conversationId, state: "delivering" },
          data: { state: "needs_review" },
        });
        await writeOwnerAction(tx, delivery, {
          actor: input.actor,
          action: "cancel_delivery",
          unitId: null,
          now: input.now,
        });
      });
      return { status: "accepted" };
    },
  };
}

const defaultReviewService = createGuideDeliveryReviewService();

export const confirmUnitDelivered = defaultReviewService.confirmUnitDelivered;
export const retryUncertainUnit = defaultReviewService.retryUncertainUnit;
export const cancelGuideDelivery = defaultReviewService.cancelGuideDelivery;
