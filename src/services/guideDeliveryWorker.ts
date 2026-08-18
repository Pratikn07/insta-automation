import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { finalizeGuideDelivery } from "./guideDeliveryCompletion.js";
import {
  guideDeliveryRepository,
  type ClaimedGuideDelivery,
  type GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";
import { processClaimedGuideDelivery } from "./guideDeliveryService.js";

type WorkerLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
};

type WorkerRepository = Pick<
  GuideDeliveryRepository,
  "reconcileExpiredClaims" | "claimDueBatch"
>;

export type GuideDeliveryWorkerOptions = {
  enabled: boolean;
  batchSize: number;
  leaseMs: number;
  repository: WorkerRepository;
  finalize(deliveryId: string, claimToken: string): Promise<unknown>;
  processClaimedGuideDelivery(delivery: ClaimedGuideDelivery): Promise<unknown>;
  now(): Date;
  logger: WorkerLogger;
};

function validate(options: GuideDeliveryWorkerOptions): void {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 50) {
    throw new Error("invalid guide delivery batch size");
  }
  if (!Number.isFinite(options.leaseMs) || options.leaseMs < 60_000) {
    throw new Error("invalid guide delivery lease");
  }
}

/**
 * Repairs expired claims before resuming only known-safe units. Provider work is
 * delegated to the delivery service, which owns the provider boundary and never
 * replays an uncertain unit.
 */
export function createGuideDeliveryWorker(options: GuideDeliveryWorkerOptions) {
  validate(options);
  return async function runGuideDeliveryTick(): Promise<void> {
    if (!options.enabled) return;

    const now = options.now();
    const reconciliation = await options.repository.reconcileExpiredClaims({
      now,
      limit: options.batchSize,
      claimLeaseMs: options.leaseMs,
    });

    for (const delivery of reconciliation.completionPending.slice(0, options.batchSize)) {
      try {
        await options.finalize(delivery.id, delivery.claimToken);
      } catch {
        options.logger.error(
          { errorCode: "guide_delivery_completion_recovery_failed", deliveryId: delivery.id },
          "Guide delivery completion recovery failed",
        );
      }
    }

    const claimed = await options.repository.claimDueBatch({
      now,
      claimExpiresAt: new Date(now.getTime() + options.leaseMs),
      limit: options.batchSize,
    });
    for (const delivery of claimed) {
      try {
        await options.processClaimedGuideDelivery(delivery);
      } catch {
        options.logger.error(
          { errorCode: "guide_delivery_process_failed", deliveryId: delivery.id },
          "Guide delivery processing failed",
        );
      }
    }
  };
}

export const runGuideDeliveryTick = createGuideDeliveryWorker({
  enabled: env.GUIDE_DELIVERY_ENABLED,
  batchSize: env.GUIDE_DELIVERY_BATCH_SIZE,
  leaseMs: env.GUIDE_DELIVERY_LEASE_MS,
  repository: guideDeliveryRepository,
  finalize: finalizeGuideDelivery,
  processClaimedGuideDelivery,
  now: () => new Date(),
  logger,
});
