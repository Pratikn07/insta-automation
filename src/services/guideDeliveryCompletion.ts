import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { markCompleted } from "./conversationService.js";
import { markThreadResolved } from "./dmThreadService.js";
import { scheduleEngagementFollowUp } from "./engagementFollowUpService.js";
import {
  guideDeliveryRepository,
  type FinalizeGuideDeliveryResult,
  type GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";

type CompletionLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

type GuideDeliveryCompletionDependencies = {
  repository: Pick<GuideDeliveryRepository, "findById" | "finalizeCompleted">;
  markCompleted: (conversationId: string) => Promise<{ completedAt: Date | null }>;
  scheduleEngagementFollowUp: typeof scheduleEngagementFollowUp;
  markThreadResolved: typeof markThreadResolved;
  followUpsEnabled: boolean;
  logger: CompletionLogger;
  now: () => Date;
};

function hasInboundTrigger(
  triggerKind: "inbound_reply" | "explicit_redelivery" | "follow_recovery",
): triggerKind is "inbound_reply" | "explicit_redelivery" {
  return triggerKind === "inbound_reply" || triggerKind === "explicit_redelivery";
}

export function createGuideDeliveryCompletion(
  dependencies: GuideDeliveryCompletionDependencies,
) {
  return async function finalize(
    deliveryId: string,
    claimToken: string,
  ): Promise<FinalizeGuideDeliveryResult> {
    const delivery = await dependencies.repository.findById(deliveryId);
    if (!delivery) return "lost_claim";
    if (delivery.status === "completed") return "already_completed";
    if (delivery.status !== "sending" || delivery.claimToken !== claimToken) {
      return "lost_claim";
    }
    if (!(delivery.units.length > 0 && delivery.units.every((unit) => unit.status === "sent"))) {
      return "not_ready";
    }
    if (delivery.units.some((unit) => unit.sentAt === null)) return "not_ready";
    const deliveryCompletedAt = new Date(
      Math.max(...delivery.units.map((unit) => unit.sentAt!.getTime())),
    );

    await dependencies.markCompleted(delivery.conversationId);
    const inboundTrigger = hasInboundTrigger(delivery.triggerKind);

    if (dependencies.followUpsEnabled && inboundTrigger && delivery.threadId) {
      try {
        await dependencies.scheduleEngagementFollowUp({
          conversationId: delivery.conversationId,
          threadId: delivery.threadId,
          inboundMessageId: delivery.triggerId,
          inboundAt: delivery.triggeredAt,
          deliveredAt: deliveryCompletedAt,
        });
      } catch {
        dependencies.logger.error(
          {
            errorCode: "follow_up_schedule_failed",
            conversationId: delivery.conversationId,
            threadId: delivery.threadId,
            inboundMessageId: delivery.triggerId,
          },
          "Failed to schedule engagement follow-up after guide delivery",
        );
      }
    }

    if (inboundTrigger && delivery.threadId) {
      await dependencies.markThreadResolved({
        threadId: delivery.threadId,
        inboundMessageId: delivery.triggerId,
      });
    }

    return dependencies.repository.finalizeCompleted({
      deliveryId,
      claimToken,
      completedAt: deliveryCompletedAt,
    });
  };
}

export const finalizeGuideDelivery = createGuideDeliveryCompletion({
  repository: guideDeliveryRepository,
  markCompleted,
  scheduleEngagementFollowUp,
  markThreadResolved,
  followUpsEnabled: env.AI_FOLLOW_UPS_ENABLED,
  logger,
  now: () => new Date(),
});
