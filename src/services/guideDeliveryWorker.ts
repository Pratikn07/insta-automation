import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { finalizeGuideDelivery } from "./guideDeliveryCompletion.js";
import {
  guideDeliveryRepository,
  type GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";
import {
  processClaimedGuideDelivery,
  type GuideDeliveryResult,
} from "./guideDeliveryService.js";

type WorkerLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

type GuideDeliveryWorkerDependencies = {
  repository: Pick<GuideDeliveryRepository, "reconcileExpiredClaims" | "claimDueBatch">;
  finalizeGuideDelivery(
    deliveryId: string,
    claimToken: string,
  ): Promise<"completed" | "already_completed" | "not_ready" | "lost_claim">;
  processClaimedGuideDelivery: (
    delivery: Awaited<ReturnType<GuideDeliveryRepository["claimDueBatch"]>>[number],
  ) => Promise<GuideDeliveryResult>;
  now(): Date;
  batchSize: number;
  leaseMs: number;
  logger: WorkerLogger;
};

export type GuideDeliveryTickResult = {
  needsReviewCount: number;
  releasedCount: number;
  terminalCount: number;
  completionPendingCount: number;
  completionFailedCount: number;
  claimedCount: number;
  processedCount: number;
  processingFailedCount: number;
};

export function createGuideDeliveryWorker(dependencies: GuideDeliveryWorkerDependencies) {
  return async function runGuideDeliveryTick(): Promise<GuideDeliveryTickResult> {
    const tickAt = dependencies.now();
    const reconciled = await dependencies.repository.reconcileExpiredClaims(tickAt);
    const result: GuideDeliveryTickResult = {
      needsReviewCount: reconciled.needsReviewDeliveryIds.length,
      releasedCount: reconciled.releasedDeliveryIds.length,
      terminalCount: reconciled.terminalDeliveryIds.length,
      completionPendingCount: reconciled.completionPending.length,
      completionFailedCount: 0,
      claimedCount: 0,
      processedCount: 0,
      processingFailedCount: 0,
    };

    for (const delivery of reconciled.completionPending) {
      try {
        const completion = await dependencies.finalizeGuideDelivery(
          delivery.id,
          delivery.claimToken,
        );
        if (completion !== "completed" && completion !== "already_completed") {
          result.completionFailedCount += 1;
          dependencies.logger.error(
            {
              errorCode: "guide_delivery_completion_failed",
              deliveryId: delivery.id,
              completionPendingCount: result.completionPendingCount,
              failedCount: result.completionFailedCount,
            },
            "Guide delivery completion failed",
          );
        }
      } catch {
        result.completionFailedCount += 1;
        dependencies.logger.error(
          {
            errorCode: "guide_delivery_completion_failed",
            deliveryId: delivery.id,
            completionPendingCount: result.completionPendingCount,
            failedCount: result.completionFailedCount,
          },
          "Guide delivery completion failed",
        );
      }
    }

    const claimed = await dependencies.repository.claimDueBatch({
      now: tickAt,
      claimExpiresAt: new Date(tickAt.getTime() + dependencies.leaseMs),
      limit: dependencies.batchSize,
    });
    result.claimedCount = claimed.length;

    for (const delivery of claimed) {
      try {
        await dependencies.processClaimedGuideDelivery(delivery);
        result.processedCount += 1;
      } catch {
        result.processingFailedCount += 1;
        dependencies.logger.error(
          {
            errorCode: "guide_delivery_processing_failed",
            deliveryId: delivery.id,
            claimedCount: result.claimedCount,
            processedCount: result.processedCount,
            failedCount: result.processingFailedCount,
          },
          "Guide delivery processing failed",
        );
      }
    }

    return result;
  };
}

export const runGuideDeliveryTick = createGuideDeliveryWorker({
  repository: guideDeliveryRepository,
  finalizeGuideDelivery,
  processClaimedGuideDelivery,
  now: () => new Date(),
  batchSize: env.GUIDE_DELIVERY_BATCH_SIZE,
  leaseMs: env.GUIDE_DELIVERY_LEASE_MS,
  logger,
});
