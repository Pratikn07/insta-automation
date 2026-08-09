import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { MetaSendResult } from "../types/meta.js";
import { sendTrackedMedia, sendTrackedText } from "./dmDeliveryService.js";
import { describeGraphError, type GraphErrorMetadata } from "./eventLogger.js";
import { finalizeGuideDelivery } from "./guideDeliveryCompletion.js";
import {
  classifyDirectMessageSendFailure,
  type DirectMessageSendDisposition,
} from "./graphErrorClassifier.js";
import {
  compileGuideDeliveryPlan,
  type AuthoredGuideMessage,
  type GuideDeliveryTriggerKind,
} from "./guideDeliveryPlanner.js";
import {
  guideDeliveryRepository,
  type ClaimedGuideDelivery,
  type GuideDeliveryRepository,
  type GuideDeliveryUnitRecord,
  type PlannedDeliveryRecord,
} from "./guideDeliveryRepository.js";

const GUIDE_DELIVERY_STEP_DELAY_MS = 800;
const DEFAULT_GUIDE_DELIVERY_LEASE_MS = 5 * 60_000;
const DEFAULT_GUIDE_DELIVERY_MAX_ATTEMPTS = 3;
const DEFAULT_GUIDE_DELIVERY_RETRY_BASE_MS = 60_000;

const UNKNOWN_ERROR_METADATA: GraphErrorMetadata = {
  category: "unknown_error",
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
  transportCode: null,
};

export type GuideDeliveryResult =
  | "completed"
  | "preflight_failed"
  | "needs_review"
  | "retry_scheduled"
  | "already_processing";

export type DeliverGuideForTriggerInput = {
  conversationId: string;
  resourceId: string;
  igUserId: string;
  threadId: string | null;
  triggerKind: GuideDeliveryTriggerKind;
  triggerId: string;
  triggeredAt: Date;
  sendWindowExpiresAt: Date;
  followerAtTrigger: boolean | null;
  redeliveryIntro?: string;
};

type DeliveryLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

type GuideDeliveryServiceDependencies = {
  repository: Pick<
    GuideDeliveryRepository,
    | "findByTrigger"
    | "findRecipientIgUserId"
    | "createOrLoadPlan"
    | "claimById"
    | "beginUnit"
    | "markUnitSent"
    | "markUnitFailed"
    | "markUnitUncertain"
    | "markWindowClosed"
    | "markAttemptsExhausted"
  >;
  loadResourceMessages(resourceId: string): Promise<AuthoredGuideMessage[]>;
  sendTrackedText(input: {
    recipientIgUserId: string;
    text: string;
    source: "guide_automation";
  }): Promise<MetaSendResult>;
  sendTrackedMedia(input: {
    recipientIgUserId: string;
    type: "image" | "file";
    url: string;
    source: "guide_automation";
  }): Promise<MetaSendResult>;
  finalizeGuideDelivery(
    deliveryId: string,
    claimToken: string,
  ): Promise<"completed" | "already_completed" | "not_ready" | "lost_claim">;
  now(): Date;
  sleep(ms: number): Promise<void>;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  logger: DeliveryLogger;
};

function hasUnconsumedOwnerAuthorization(unit: GuideDeliveryUnitRecord): boolean {
  return unit.ownerRetryAuthorizedAt !== null && unit.ownerRetryConsumedAt === null;
}

function allSent(units: readonly GuideDeliveryUnitRecord[]): boolean {
  return units.length > 0 && units.every((unit) => unit.status === "sent");
}

function isWindowClosed(at: Date, expiresAt: Date): boolean {
  return at.getTime() >= expiresAt.getTime();
}

function resultForStoredDelivery(delivery: PlannedDeliveryRecord): GuideDeliveryResult | null {
  if (delivery.status === "completed" || delivery.status === "sending") {
    return "already_processing";
  }
  if (delivery.failureCode === "guide_preflight_failed") return "preflight_failed";
  if (delivery.status === "needs_review") return "needs_review";
  if (delivery.status === "failed" && delivery.failureCode !== "guide_unit_transient") {
    return "needs_review";
  }
  return null;
}

function retryAt(
  failedAt: Date,
  attempts: number,
  retryBaseMs: number,
  sendWindowExpiresAt: Date,
): Date | null {
  const delayMs = retryBaseMs * 2 ** Math.max(0, attempts - 1);
  const candidate = new Date(failedAt.getTime() + delayMs);
  return candidate < sendWindowExpiresAt ? candidate : null;
}

async function loadCurrentResourceMessages(resourceId: string): Promise<AuthoredGuideMessage[]> {
  return prisma.resourceMessage.findMany({
    where: { resourceId },
    orderBy: { order: "asc" },
    select: { id: true, order: true, type: true, body: true, mediaUrl: true },
  });
}

export function createGuideDeliveryService(dependencies: GuideDeliveryServiceDependencies) {
  async function checkpointAfterProvider(
    operation: () => Promise<boolean>,
    context: {
      errorCode: string;
      deliveryId: string;
      unit: GuideDeliveryUnitRecord;
    },
  ): Promise<boolean> {
    try {
      const recorded = await operation();
      if (recorded) return true;
    } catch {
      // The provider boundary has already been crossed. The raw database error
      // is intentionally discarded so snapshots/provider payloads cannot leak.
    }
    dependencies.logger.error(
      {
        errorCode: context.errorCode,
        deliveryId: context.deliveryId,
        unitId: context.unit.id,
        position: context.unit.position,
        unitKind: context.unit.kind,
        attempt: context.unit.attempts,
      },
      "Guide delivery checkpoint failed after provider call",
    );
    return false;
  }

  async function closeWindow(
    delivery: ClaimedGuideDelivery,
    closedAt: Date,
    unit?: GuideDeliveryUnitRecord,
  ): Promise<GuideDeliveryResult> {
    try {
      const closed = await dependencies.repository.markWindowClosed({
        deliveryId: delivery.id,
        claimToken: delivery.claimToken,
        closedAt,
        ...(unit ? { unitId: unit.id, attempt: unit.attempts } : {}),
      });
      return closed ? "needs_review" : "already_processing";
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_delivery_window_checkpoint_failed", deliveryId: delivery.id },
        "Failed to checkpoint a closed guide delivery window",
      );
      return "already_processing";
    }
  }

  async function finalize(
    delivery: ClaimedGuideDelivery,
  ): Promise<GuideDeliveryResult> {
    const result = await dependencies.finalizeGuideDelivery(
      delivery.id,
      delivery.claimToken,
    );
    return result === "completed" ? "completed" : "already_processing";
  }

  async function sendUnit(
    unit: GuideDeliveryUnitRecord,
    igUserId: string,
  ): Promise<MetaSendResult> {
    if (unit.kind === "text") {
      if (!unit.textSnapshot) throw new Error("invalid_persisted_guide_text_unit");
      return dependencies.sendTrackedText({
        recipientIgUserId: igUserId,
        text: unit.textSnapshot,
        source: "guide_automation",
      });
    }
    if (!unit.mediaUrlSnapshot) throw new Error("invalid_persisted_guide_media_unit");
    return dependencies.sendTrackedMedia({
      recipientIgUserId: igUserId,
      type: unit.kind,
      url: unit.mediaUrlSnapshot,
      source: "guide_automation",
    });
  }

  async function checkpointFailure(
    delivery: ClaimedGuideDelivery,
    unit: GuideDeliveryUnitRecord,
    error: GraphErrorMetadata,
    disposition: DirectMessageSendDisposition,
    failedAt: Date,
  ): Promise<GuideDeliveryResult> {
    if (disposition === "uncertain") {
      const recorded = await checkpointAfterProvider(
        () => dependencies.repository.markUnitUncertain({
          deliveryId: delivery.id,
          unitId: unit.id,
          claimToken: delivery.claimToken,
          attempt: unit.attempts,
          uncertainAt: failedAt,
          error,
        }),
        {
          errorCode: "guide_delivery_uncertain_checkpoint_failed",
          deliveryId: delivery.id,
          unit,
        },
      );
      return recorded ? "needs_review" : "already_processing";
    }

    const transient = disposition === "definite_transient";
    const nextAttemptAt = transient && unit.attempts < dependencies.maxAttempts
      ? retryAt(
          failedAt,
          unit.attempts,
          dependencies.retryBaseMs,
          delivery.sendWindowExpiresAt,
        )
      : null;
    const failureCheckpoint = !transient
      ? {
          disposition: "permanent" as const,
          nextAttemptAt: null,
          terminalReason: null,
        }
      : nextAttemptAt
        ? {
            disposition: "transient" as const,
            nextAttemptAt,
            terminalReason: null,
          }
        : {
            disposition: "transient" as const,
            nextAttemptAt: null,
            terminalReason: unit.attempts >= dependencies.maxAttempts
              ? {
                  code: "attempts_exhausted" as const,
                  maxAttempts: dependencies.maxAttempts,
                }
              : { code: "messaging_window_closed" as const },
          };
    const recorded = await checkpointAfterProvider(
      () => dependencies.repository.markUnitFailed({
        deliveryId: delivery.id,
        unitId: unit.id,
        claimToken: delivery.claimToken,
        attempt: unit.attempts,
        failedAt,
        ...failureCheckpoint,
        error,
      }),
      {
        errorCode: "guide_delivery_failure_checkpoint_failed",
        deliveryId: delivery.id,
        unit,
      },
    );
    if (!recorded) return "already_processing";
    return transient && nextAttemptAt ? "retry_scheduled" : "needs_review";
  }

  async function processClaimed(
    delivery: ClaimedGuideDelivery,
    igUserId: string,
  ): Promise<GuideDeliveryResult> {
    const localUnits = delivery.units.map((unit) => ({ ...unit }));
    if (allSent(localUnits)) return finalize(delivery);

    while (true) {
      const nextUnit = localUnits.find((unit) => unit.status !== "sent");
      if (!nextUnit) return finalize(delivery);

      if (
        nextUnit.status === "failed" &&
        nextUnit.failureDisposition === "transient" &&
        nextUnit.attempts >= dependencies.maxAttempts &&
        !hasUnconsumedOwnerAuthorization(nextUnit)
      ) {
        try {
          const terminal = await dependencies.repository.markAttemptsExhausted({
            deliveryId: delivery.id,
            claimToken: delivery.claimToken,
            exhaustedAt: dependencies.now(),
            maxAttempts: dependencies.maxAttempts,
          });
          return terminal ? "needs_review" : "already_processing";
        } catch {
          dependencies.logger.error(
            { errorCode: "guide_delivery_attempt_cap_checkpoint_failed", deliveryId: delivery.id },
            "Failed to checkpoint exhausted guide delivery attempts",
          );
          return "already_processing";
        }
      }

      const beforeBegin = dependencies.now();
      if (isWindowClosed(beforeBegin, delivery.sendWindowExpiresAt)) {
        return closeWindow(delivery, beforeBegin);
      }

      const begun = await dependencies.repository.beginUnit({
        deliveryId: delivery.id,
        claimToken: delivery.claimToken,
        now: beforeBegin,
        maxAttempts: dependencies.maxAttempts,
      });
      if (!begun) return "already_processing";

      const immediatelyBeforeSend = dependencies.now();
      if (isWindowClosed(immediatelyBeforeSend, delivery.sendWindowExpiresAt)) {
        return closeWindow(delivery, immediatelyBeforeSend, begun);
      }

      let receipt: MetaSendResult;
      try {
        receipt = await sendUnit(begun, igUserId);
      } catch (providerError) {
        const metadata = describeGraphError(providerError);
        const disposition = classifyDirectMessageSendFailure(metadata);
        return checkpointFailure(
          delivery,
          begun,
          metadata,
          disposition,
          dependencies.now(),
        );
      }

      if (!receipt.messageId) {
        return checkpointFailure(
          delivery,
          begun,
          UNKNOWN_ERROR_METADATA,
          "uncertain",
          dependencies.now(),
        );
      }

      const sentAt = dependencies.now();
      const recorded = await checkpointAfterProvider(
        () => dependencies.repository.markUnitSent({
          deliveryId: delivery.id,
          unitId: begun.id,
          claimToken: delivery.claimToken,
          attempt: begun.attempts,
          sentAt,
          providerMessageId: receipt.messageId,
          ownerConfirmedAt: null,
        }),
        {
          errorCode: "guide_delivery_success_checkpoint_failed",
          deliveryId: delivery.id,
          unit: begun,
        },
      );
      if (!recorded) return "already_processing";

      const local = localUnits.find((unit) => unit.id === begun.id);
      if (!local) return "already_processing";
      local.status = "sent";
      local.providerMessageId = receipt.messageId;
      local.sentAt = sentAt;
      local.attempts = begun.attempts;

      if (allSent(localUnits)) return finalize(delivery);
      await dependencies.sleep(GUIDE_DELIVERY_STEP_DELAY_MS);
    }
  }

  async function processClaimedGuideDelivery(
    delivery: ClaimedGuideDelivery,
  ): Promise<GuideDeliveryResult> {
    let recipientIgUserId: string | null;
    try {
      recipientIgUserId = await dependencies.repository.findRecipientIgUserId(delivery.id);
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_delivery_recipient_lookup_failed", deliveryId: delivery.id },
        "Failed to resolve persisted guide delivery recipient",
      );
      return "already_processing";
    }
    if (!recipientIgUserId) {
      dependencies.logger.error(
        { errorCode: "guide_delivery_recipient_missing", deliveryId: delivery.id },
        "Persisted guide delivery has no recipient",
      );
      return "already_processing";
    }
    return processClaimed(delivery, recipientIgUserId);
  }

  const deliverGuideForTrigger = async function deliverGuideForTrigger(
    input: DeliverGuideForTriggerInput,
  ): Promise<GuideDeliveryResult> {
    let delivery = await dependencies.repository.findByTrigger({
      triggerKind: input.triggerKind,
      triggerId: input.triggerId,
    });

    if (!delivery) {
      const messages = await dependencies.loadResourceMessages(input.resourceId);
      const plan = compileGuideDeliveryPlan({
        messages,
        triggerKind: input.triggerKind,
        redeliveryIntro: input.redeliveryIntro,
      });
      delivery = await dependencies.repository.createOrLoadPlan({
        conversationId: input.conversationId,
        resourceId: input.resourceId,
        threadId: input.threadId,
        triggerKind: input.triggerKind,
        triggerId: input.triggerId,
        triggeredAt: input.triggeredAt,
        sendWindowExpiresAt: input.sendWindowExpiresAt,
        followerAtTrigger: input.followerAtTrigger,
        plan,
      });
    }

    const storedResult = resultForStoredDelivery(delivery);
    if (storedResult) return storedResult;

    const claimAt = dependencies.now();
    const claimed = await dependencies.repository.claimById({
      deliveryId: delivery.id,
      now: claimAt,
      claimExpiresAt: new Date(claimAt.getTime() + dependencies.leaseMs),
    });
    if (!claimed) return "already_processing";
    return processClaimedGuideDelivery(claimed);
  };

  return Object.assign(deliverGuideForTrigger, { processClaimedGuideDelivery });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const guideDeliveryService = createGuideDeliveryService({
  repository: guideDeliveryRepository,
  loadResourceMessages: loadCurrentResourceMessages,
  sendTrackedText,
  sendTrackedMedia,
  finalizeGuideDelivery,
  now: () => new Date(),
  sleep,
  leaseMs: DEFAULT_GUIDE_DELIVERY_LEASE_MS,
  maxAttempts: DEFAULT_GUIDE_DELIVERY_MAX_ATTEMPTS,
  retryBaseMs: DEFAULT_GUIDE_DELIVERY_RETRY_BASE_MS,
  logger,
});

export const deliverGuideForTrigger = guideDeliveryService;
export const processClaimedGuideDelivery = guideDeliveryService.processClaimedGuideDelivery;
