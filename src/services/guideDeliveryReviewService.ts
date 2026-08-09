import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { finalizeGuideDelivery } from "./guideDeliveryCompletion.js";
import {
  guideDeliveryRepository,
  type ClaimedGuideDelivery,
  type GuideDeliveryRepository,
  type OwnerGuideDeliveryTransitionResult,
} from "./guideDeliveryRepository.js";
import {
  processClaimedGuideDelivery,
  type GuideDeliveryResult,
} from "./guideDeliveryService.js";

export type GuideDeliveryReviewResult =
  | OwnerGuideDeliveryTransitionResult
  | { ok: false; error: "duplicate_risk_acknowledgement_required" };

export type ConfirmUnitDeliveredInput = {
  deliveryId: string;
  unitId: string;
  actor: string;
  now: Date;
};

export type RetryUncertainUnitInput = ConfirmUnitDeliveredInput & {
  acknowledgeDuplicateRisk: boolean;
};

export type CancelGuideDeliveryInput = {
  deliveryId: string;
  actor: string;
  now: Date;
};

type ReviewLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

type GuideDeliveryReviewDependencies = {
  repository: Pick<
    GuideDeliveryRepository,
    | "ownerConfirmUnitDelivered"
    | "ownerRetryUncertainUnit"
    | "ownerCancelDelivery"
    | "claimById"
  >;
  processClaimedGuideDelivery(delivery: ClaimedGuideDelivery): Promise<GuideDeliveryResult>;
  finalizeGuideDelivery(
    deliveryId: string,
    claimToken: string,
  ): Promise<"completed" | "already_completed" | "not_ready" | "lost_claim">;
  leaseMs: number;
  logger: ReviewLogger;
};

export function createGuideDeliveryReviewService(
  dependencies: GuideDeliveryReviewDependencies,
) {
  async function startPostCommitWork(
    result: OwnerGuideDeliveryTransitionResult,
    deliveryId: string,
    now: Date,
  ): Promise<void> {
    if (!result.ok || result.directive === "none") return;
    try {
      const claimed = await dependencies.repository.claimById({
        deliveryId,
        now,
        claimExpiresAt: new Date(now.getTime() + dependencies.leaseMs),
      });
      if (!claimed) return;
      if (result.directive === "finalize") {
        await dependencies.finalizeGuideDelivery(deliveryId, claimed.claimToken);
      } else {
        await dependencies.processClaimedGuideDelivery(claimed);
      }
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_delivery_owner_resume_failed", deliveryId },
        "Guide delivery owner action could not start post-commit work",
      );
    }
  }

  return {
    async confirmUnitDelivered(
      input: ConfirmUnitDeliveredInput,
    ): Promise<GuideDeliveryReviewResult> {
      const result = await dependencies.repository.ownerConfirmUnitDelivered(input);
      await startPostCommitWork(result, input.deliveryId, input.now);
      return result;
    },

    async retryUncertainUnit(
      input: RetryUncertainUnitInput,
    ): Promise<GuideDeliveryReviewResult> {
      if (input.acknowledgeDuplicateRisk !== true) {
        return { ok: false, error: "duplicate_risk_acknowledgement_required" };
      }
      const result = await dependencies.repository.ownerRetryUncertainUnit({
        deliveryId: input.deliveryId,
        unitId: input.unitId,
        actor: input.actor,
        now: input.now,
      });
      await startPostCommitWork(result, input.deliveryId, input.now);
      return result;
    },

    async cancelGuideDelivery(
      input: CancelGuideDeliveryInput,
    ): Promise<GuideDeliveryReviewResult> {
      return dependencies.repository.ownerCancelDelivery(input);
    },
  };
}

export const guideDeliveryReviewService = createGuideDeliveryReviewService({
  repository: guideDeliveryRepository,
  processClaimedGuideDelivery,
  finalizeGuideDelivery,
  leaseMs: env.GUIDE_DELIVERY_LEASE_MS,
  logger,
});

export const {
  confirmUnitDelivered,
  retryUncertainUnit,
  cancelGuideDelivery,
} = guideDeliveryReviewService;
