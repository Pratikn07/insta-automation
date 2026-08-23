import type {
  GuideDeliveryStatus,
  GuideDeliveryTriggerKind,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { env } from "../config/env.js";
import { flags } from "./flagService.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { markCompleted } from "./conversationService.js";
import { markThreadResolved } from "./dmThreadService.js";
import { guideAccessRepository } from "./guideAccessRepository.js";
import {
  scheduleEngagementFollowUp,
  type ScheduleEngagementFollowUpInput,
} from "./engagementFollowUpService.js";

export type GuideDeliveryCompletionResult =
  | "completed"
  | "already_completed"
  | "not_ready"
  | "lost_claim";

export type GuideDeliveryCompletionRecord = {
  id: string;
  conversationId: string;
  threadId: string | null;
  triggerKind: GuideDeliveryTriggerKind;
  triggerId: string;
  triggeredAt: Date;
  sendWindowExpiresAt: Date;
  followerAtTrigger: boolean | null;
  status: GuideDeliveryStatus;
  claimToken: string | null;
  completedAt: Date | null;
  totalUnitCount: number;
  sentUnitCount: number;
};

export type FinalizeGuideDeliveryAtomicallyInput = {
  deliveryId: string;
  claimToken: string;
  completedAt: Date;
};

export interface GuideDeliveryCompletionRepository {
  loadForCompletion(deliveryId: string): Promise<GuideDeliveryCompletionRecord | null>;
  finalizeAtomically(
    input: FinalizeGuideDeliveryAtomicallyInput,
  ): Promise<GuideDeliveryCompletionResult>;
}

export type GuideDeliveryCompletionDatabase = Pick<PrismaClient, "$transaction">;

type CompletionTransaction = Prisma.TransactionClient;

type CompletionLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

type CompletionDependencies = {
  repository: GuideDeliveryCompletionRepository;
  markConversationCompleted(conversationId: string): Promise<{ completedAt: Date | null }>;
  scheduleEngagementFollowUp(input: ScheduleEngagementFollowUpInput): Promise<unknown>;
  markThreadResolved(input: { threadId: string; inboundMessageId: string }): Promise<void>;
  settleAccessAttempt(input: {
    conversationId: string;
    outcome: "delivered" | "needs_review";
    expectedWindowExpiresAt: Date;
  }): Promise<"settled" | "already_settled" | "not_found" | "window_mismatch">;
  followUpsEnabled(): boolean;
  logger: CompletionLogger;
  now(): Date;
};

function hasInboundTrigger(
  triggerKind: GuideDeliveryTriggerKind,
): triggerKind is "inbound_reply" | "explicit_redelivery" {
  return triggerKind === "inbound_reply" || triggerKind === "explicit_redelivery";
}

async function loadCompletionRecord(
  tx: CompletionTransaction,
  deliveryId: string,
): Promise<GuideDeliveryCompletionRecord | null> {
  const delivery = await tx.guideDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      conversationId: true,
      threadId: true,
      triggerKind: true,
      triggerId: true,
      triggeredAt: true,
      sendWindowExpiresAt: true,
      followerAtTrigger: true,
      status: true,
      claimToken: true,
      completedAt: true,
    },
  });
  if (!delivery) return null;

  const [totalUnitCount, sentUnitCount] = await Promise.all([
    tx.guideDeliveryUnit.count({ where: { deliveryId } }),
    tx.guideDeliveryUnit.count({ where: { deliveryId, status: "sent" } }),
  ]);
  return { ...delivery, totalUnitCount, sentUnitCount };
}

export function createGuideDeliveryCompletionRepository(
  options: { database?: GuideDeliveryCompletionDatabase } = {},
): GuideDeliveryCompletionRepository {
  const database = options.database ?? prisma;

  return {
    loadForCompletion(deliveryId) {
      return database.$transaction((tx) => loadCompletionRecord(tx, deliveryId));
    },

    finalizeAtomically(input) {
      return database.$transaction(async (tx) => {
        const delivery = await tx.guideDelivery.findUnique({
          where: { id: input.deliveryId },
          select: {
            id: true,
            conversationId: true,
            resourceId: true,
            threadId: true,
            triggerKind: true,
            triggerId: true,
            triggeredAt: true,
            followerAtTrigger: true,
            status: true,
            claimToken: true,
            completedAt: true,
          },
        });
        if (!delivery) return "lost_claim";
        if (delivery.status === "completed") return "already_completed";
        if (delivery.status !== "sending" || delivery.claimToken !== input.claimToken) {
          return "lost_claim";
        }

        const [totalUnitCount, unsentUnitCount] = await Promise.all([
          tx.guideDeliveryUnit.count({ where: { deliveryId: input.deliveryId } }),
          tx.guideDeliveryUnit.count({
            where: { deliveryId: input.deliveryId, status: { not: "sent" } },
          }),
        ]);
        if (totalUnitCount === 0 || unsentUnitCount !== 0) return "not_ready";

        const updated = await tx.guideDelivery.updateMany({
          where: { id: input.deliveryId, status: "sending", claimToken: input.claimToken },
          data: {
            status: "completed",
            failureCode: null,
            nextAttemptAt: null,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
        if (updated.count !== 1) return "lost_claim";

        await tx.eventLog.create({
          data: {
            kind: "sequence_completed",
            payload: {
              deliveryId: delivery.id,
              conversationId: delivery.conversationId,
              resourceId: delivery.resourceId,
              threadId: delivery.threadId,
              triggerKind: delivery.triggerKind,
              triggerId: delivery.triggerId,
              unitCount: totalUnitCount,
              followerAtTrigger: delivery.followerAtTrigger,
              // Existing analytics readers consume this name. It is the same
              // persisted trigger-time fact, not a fresh/private provider read.
              followerAtDelivery: delivery.followerAtTrigger,
              completedAt: input.completedAt.toISOString(),
            },
          },
        });
        return "completed";
      });
    },
  };
}

/**
 * Closes the guide-access attempt this delivery belongs to. Never throws to the caller: a
 * delivery whose units all provably went out must not be failed because its attempt could
 * not be closed. An attempt stuck in `delivering` is released lazily by the parent's next
 * inbound, so the cost of a miss is bounded — but it has to be visible.
 */
async function settleAttempt(
  dependencies: CompletionDependencies,
  delivery: GuideDeliveryCompletionRecord,
): Promise<void> {
  let outcome: Awaited<ReturnType<CompletionDependencies["settleAccessAttempt"]>>;
  try {
    outcome = await dependencies.settleAccessAttempt({
      conversationId: delivery.conversationId,
      outcome: "delivered",
      expectedWindowExpiresAt: delivery.sendWindowExpiresAt,
    });
  } catch {
    dependencies.logger.error(
      {
        errorCode: "access_attempt_settle_failed",
        deliveryId: delivery.id,
        conversationId: delivery.conversationId,
      },
      "Guide access attempt could not be settled after delivery completion",
    );
    return;
  }

  // `not_found` is the normal shape for every delivery that predates the strict gate or
  // was triggered outside it. The other two mean an attempt exists but is not the one this
  // delivery was built from, or was moved by some path that should not have.
  if (outcome === "settled" || outcome === "not_found") return;
  dependencies.logger.error(
    {
      errorCode: "access_attempt_settle_refused",
      outcome,
      deliveryId: delivery.id,
      conversationId: delivery.conversationId,
      sendWindowExpiresAt: delivery.sendWindowExpiresAt.toISOString(),
    },
    "Guide access attempt was not the one this delivery belonged to",
  );
}

export function createGuideDeliveryCompletionService(
  dependencies: CompletionDependencies,
) {
  return {
    async finalizeGuideDelivery(
      deliveryId: string,
      claimToken: string,
    ): Promise<GuideDeliveryCompletionResult> {
      const delivery = await dependencies.repository.loadForCompletion(deliveryId);
      if (!delivery) return "lost_claim";
      if (delivery.status === "completed") return "already_completed";
      if (delivery.status !== "sending" || delivery.claimToken !== claimToken) {
        return "lost_claim";
      }
      if (
        delivery.totalUnitCount === 0 ||
        delivery.sentUnitCount !== delivery.totalUnitCount
      ) {
        return "not_ready";
      }

      const conversation = await dependencies.markConversationCompleted(delivery.conversationId);

      const completionTime = conversation.completedAt ?? dependencies.now();
      const inboundTrigger = hasInboundTrigger(delivery.triggerKind);

      if (dependencies.followUpsEnabled() && inboundTrigger && delivery.threadId) {
        if (!conversation.completedAt) {
          dependencies.logger.error(
            {
              errorCode: "follow_up_completion_timestamp_missing",
              deliveryId: delivery.id,
              conversationId: delivery.conversationId,
              threadId: delivery.threadId,
              inboundMessageId: delivery.triggerId,
            },
            "Failed to schedule engagement follow-up after guide delivery",
          );
        } else {
          try {
            await dependencies.scheduleEngagementFollowUp({
              conversationId: delivery.conversationId,
              threadId: delivery.threadId,
              inboundMessageId: delivery.triggerId,
              inboundAt: delivery.triggeredAt,
              deliveredAt: conversation.completedAt,
            });
          } catch {
            dependencies.logger.error(
              {
                errorCode: "follow_up_schedule_failed",
                deliveryId: delivery.id,
                conversationId: delivery.conversationId,
                threadId: delivery.threadId,
                inboundMessageId: delivery.triggerId,
              },
              "Failed to schedule engagement follow-up after guide delivery",
            );
          }
        }
      }

      if (inboundTrigger && delivery.threadId) {
        await dependencies.markThreadResolved({
          threadId: delivery.threadId,
          inboundMessageId: delivery.triggerId,
        });
      }

      const finalized = await dependencies.repository.finalizeAtomically({
        deliveryId,
        claimToken,
        completedAt: completionTime,
      });

      // Only after the ledger is durably `completed`. `delivering` is an ACTIVE attempt
      // state, so leaving it unsettled would keep `createOrLoadAttempt` loading this
      // attempt and block the parent's next request for the rest of the messaging
      // window. But settling FIRST is worse than settling late: a crash in between would
      // release the conversation while the delivery is still `sending`, letting the
      // parent open a fresh attempt and authorizing a duplicate send. A settle that never
      // happens leaves the attempt in `delivering`, which the next inbound expires
      // lazily. Order accordingly, and only when this worker really did finalize.
      if (finalized === "completed") {
        await settleAttempt(dependencies, delivery);
      }

      return finalized;
    },
  };
}

export const guideDeliveryCompletionRepository = createGuideDeliveryCompletionRepository();

const defaultCompletionService = createGuideDeliveryCompletionService({
  settleAccessAttempt: (settle) =>
    guideAccessRepository.settleAttemptForConversation(settle),
  repository: guideDeliveryCompletionRepository,
  markConversationCompleted: markCompleted,
  scheduleEngagementFollowUp,
  markThreadResolved,
  followUpsEnabled: () => flags.bool("AI_FOLLOW_UPS_ENABLED"),
  logger,
  now: () => new Date(),
});

export const finalizeGuideDelivery = defaultCompletionService.finalizeGuideDelivery;
