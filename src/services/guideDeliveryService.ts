import type { DmMessageSource } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { MetaSendResult } from "../types/meta.js";
import { sendTrackedMedia, sendTrackedText } from "./dmDeliveryService.js";
import { describeGraphError, type GraphErrorMetadata } from "./eventLogger.js";
import { finalizeGuideDelivery } from "./guideDeliveryCompletion.js";
import {
  classifyDirectMessageSend,
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

const STEP_DELAY_MS = 800;

const UNKNOWN_ERROR_METADATA: GraphErrorMetadata = {
  category: "unknown_error",
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
  transportCode: null,
};

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

export type GuideDeliveryResult =
  | "completed"
  | "preflight_failed"
  | "needs_review"
  | "retry_scheduled"
  | "already_processing";

export type GuideDeliveryServiceRepository = Pick<
  GuideDeliveryRepository,
  | "createOrLoadPlan"
  | "claimById"
  | "beginUnit"
  | "markUnitSent"
  | "markUnitRetryable"
  | "markUnitFailed"
  | "markUnitUncertain"
  | "markWindowClosed"
  | "releaseClaim"
> & {
  findByTrigger(input: {
    triggerKind: GuideDeliveryTriggerKind;
    triggerId: string;
  }): Promise<PlannedDeliveryRecord | null>;
  findRecipientIgUserId(deliveryId: string): Promise<string | null>;
};

type DeliveryLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
};

type GuideDeliveryServiceDependencies = {
  repository: GuideDeliveryServiceRepository;
  loadResourceMessages(resourceId: string): Promise<AuthoredGuideMessage[]>;
  sendText(input: {
    recipientIgUserId: string;
    text: string;
    source: DmMessageSource;
  }): Promise<MetaSendResult>;
  sendMedia(input: {
    recipientIgUserId: string;
    type: "image" | "file";
    url: string;
    source: DmMessageSource;
  }): Promise<MetaSendResult>;
  finalizeGuideDelivery(
    deliveryId: string,
    claimToken: string,
  ): Promise<"completed" | "already_completed" | "not_ready" | "lost_claim">;
  sleep(ms: number): Promise<void>;
  now(): Date;
  logger: DeliveryLogger;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelayMs: number;
};

function validateOptions(dependencies: GuideDeliveryServiceDependencies): void {
  if (!Number.isInteger(dependencies.maxAttempts) || dependencies.maxAttempts < 1) {
    throw new Error("invalid guide delivery attempt cap");
  }
  if (!Number.isFinite(dependencies.claimLeaseMs) || dependencies.claimLeaseMs <= 0) {
    throw new Error("invalid guide delivery claim lease");
  }
  if (!Number.isFinite(dependencies.retryDelayMs) || dependencies.retryDelayMs <= 0) {
    throw new Error("invalid guide delivery retry delay");
  }
}

function isWindowClosed(now: Date, expiresAt: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

function allUnitsSent(units: readonly GuideDeliveryUnitRecord[]): boolean {
  return units.length > 0 && units.every((unit) => unit.status === "sent");
}

function retryTime(
  failedAt: Date,
  attempt: number,
  baseDelayMs: number,
  windowExpiresAt: Date,
): Date | null {
  const delayMs = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const candidate = new Date(failedAt.getTime() + delayMs);
  return candidate < windowExpiresAt ? candidate : null;
}

function resultForStoredDelivery(delivery: PlannedDeliveryRecord): GuideDeliveryResult | null {
  if (delivery.status === "completed" || delivery.status === "sending") {
    return "already_processing";
  }
  if (delivery.status === "needs_review" || delivery.status === "cancelled") {
    return "needs_review";
  }
  if (delivery.status === "failed" && delivery.nextAttemptAt === null) {
    return delivery.failureCode === "invalid_plan" ? "preflight_failed" : "needs_review";
  }
  return null;
}

export function createGuideDeliveryService(dependencies: GuideDeliveryServiceDependencies) {
  validateOptions(dependencies);

  async function checkpointAfterBoundary(
    operation: () => Promise<boolean>,
    delivery: ClaimedGuideDelivery,
    unit: GuideDeliveryUnitRecord,
    errorCode: string,
  ): Promise<boolean> {
    try {
      if (await operation()) return true;
    } catch {
      // The provider boundary may already have been crossed. Never attach the
      // raw database/provider error and never replay this unit in-process.
    }
    dependencies.logger.error(
      {
        errorCode,
        deliveryId: delivery.id,
        unitId: unit.id,
        position: unit.position,
        unitKind: unit.kind,
        attempt: unit.attempts,
      },
      "Guide delivery checkpoint failed after provider boundary",
    );
    return false;
  }

  async function sendUnit(
    unit: GuideDeliveryUnitRecord,
    igUserId: string,
  ): Promise<MetaSendResult> {
    if (unit.kind === "text") {
      if (!unit.textSnapshot) throw new Error("invalid persisted guide text unit");
      return dependencies.sendText({
        recipientIgUserId: igUserId,
        text: unit.textSnapshot,
        source: "guide_automation",
      });
    }
    if (!unit.mediaUrlSnapshot) throw new Error("invalid persisted guide media unit");
    return dependencies.sendMedia({
      recipientIgUserId: igUserId,
      type: unit.kind,
      url: unit.mediaUrlSnapshot,
      source: "guide_automation",
    });
  }

  async function checkpointFailure(
    delivery: ClaimedGuideDelivery,
    unit: GuideDeliveryUnitRecord,
    metadata: GraphErrorMetadata,
    disposition: DirectMessageSendDisposition,
    failedAt: Date,
  ): Promise<GuideDeliveryResult> {
    if (disposition === "uncertain") {
      const recorded = await checkpointAfterBoundary(
        () =>
          dependencies.repository.markUnitUncertain({
            deliveryId: delivery.id,
            unitId: unit.id,
            claimToken: delivery.claimToken,
            attempt: unit.attempts,
            failureCode: "provider_outcome_uncertain",
            error: metadata,
            now: failedAt,
          }),
        delivery,
        unit,
        "guide_delivery_uncertain_checkpoint_failed",
      );
      return recorded ? "needs_review" : "already_processing";
    }

    if (disposition === "definite_permanent") {
      const recorded = await checkpointAfterBoundary(
        () =>
          dependencies.repository.markUnitFailed({
            deliveryId: delivery.id,
            unitId: unit.id,
            claimToken: delivery.claimToken,
            attempt: unit.attempts,
            failureCode: "provider_permanent",
            error: metadata,
            now: failedAt,
          }),
        delivery,
        unit,
        "guide_delivery_failure_checkpoint_failed",
      );
      return recorded ? "needs_review" : "already_processing";
    }

    const nextAttemptAt =
      unit.attempts < dependencies.maxAttempts
        ? retryTime(
            failedAt,
            unit.attempts,
            dependencies.retryDelayMs,
            delivery.sendWindowExpiresAt,
          )
        : null;
    if (nextAttemptAt) {
      const recorded = await checkpointAfterBoundary(
        () =>
          dependencies.repository.markUnitRetryable({
            deliveryId: delivery.id,
            unitId: unit.id,
            claimToken: delivery.claimToken,
            attempt: unit.attempts,
            failureCode: "provider_transient",
            nextAttemptAt,
            error: metadata,
            now: failedAt,
          }),
        delivery,
        unit,
        "guide_delivery_retry_checkpoint_failed",
      );
      return recorded ? "retry_scheduled" : "already_processing";
    }

    const failureCode =
      unit.attempts >= dependencies.maxAttempts
        ? "provider_retry_exhausted"
        : "messaging_window_closed";
    const recorded = await checkpointAfterBoundary(
      () =>
        dependencies.repository.markUnitFailed({
          deliveryId: delivery.id,
          unitId: unit.id,
          claimToken: delivery.claimToken,
          attempt: unit.attempts,
          failureCode,
          failureDisposition: "transient",
          error: metadata,
          now: failedAt,
        }),
      delivery,
      unit,
      "guide_delivery_terminal_checkpoint_failed",
    );
    return recorded ? "needs_review" : "already_processing";
  }

  async function processClaimed(
    delivery: ClaimedGuideDelivery,
    igUserId: string,
  ): Promise<GuideDeliveryResult> {
    const units = delivery.units.map((unit) => ({ ...unit }));
    if (allUnitsSent(units)) {
      const result = await dependencies.finalizeGuideDelivery(delivery.id, delivery.claimToken);
      return result === "completed" ? "completed" : "already_processing";
    }

    while (true) {
      const beforeBegin = dependencies.now();
      if (isWindowClosed(beforeBegin, delivery.sendWindowExpiresAt)) {
        try {
          const closed = await dependencies.repository.markWindowClosed({
            deliveryId: delivery.id,
            claimToken: delivery.claimToken,
            now: beforeBegin,
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

      const renewedClaimExpiresAt = new Date(
        beforeBegin.getTime() + dependencies.claimLeaseMs,
      );
      const begun = await dependencies.repository.beginUnit({
        deliveryId: delivery.id,
        claimToken: delivery.claimToken,
        now: beforeBegin,
        claimExpiresAt: renewedClaimExpiresAt,
      });
      if (!begun) {
        return "already_processing";
      }

      const immediatelyBeforeProvider = dependencies.now();
      if (isWindowClosed(immediatelyBeforeProvider, delivery.sendWindowExpiresAt)) {
        const recorded = await dependencies.repository.markWindowClosed({
          deliveryId: delivery.id,
          unitId: begun.id,
          claimToken: delivery.claimToken,
          attempt: begun.attempts,
          now: immediatelyBeforeProvider,
        });
        return recorded ? "needs_review" : "already_processing";
      }
      if (isWindowClosed(immediatelyBeforeProvider, renewedClaimExpiresAt)) {
        return "already_processing";
      }

      let receipt: MetaSendResult;
      try {
        receipt = await sendUnit(begun, igUserId);
      } catch (error) {
        const metadata = describeGraphError(error);
        return checkpointFailure(
          delivery,
          begun,
          metadata,
          classifyDirectMessageSend(metadata),
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
      const checkpointed = await checkpointAfterBoundary(
        () =>
          dependencies.repository.markUnitSent({
            deliveryId: delivery.id,
            unitId: begun.id,
            claimToken: delivery.claimToken,
            attempt: begun.attempts,
            providerMessageId: receipt.messageId,
            ownerConfirmedAt: null,
            now: sentAt,
          }),
        delivery,
        begun,
        "guide_delivery_success_checkpoint_failed",
      );
      if (!checkpointed) return "already_processing";

      const local = units.find((unit) => unit.id === begun.id);
      if (!local) return "already_processing";
      local.status = "sent";
      local.providerMessageId = receipt.messageId;
      local.sentAt = sentAt;
      local.attempts = begun.attempts;

      if (allUnitsSent(units)) {
        const result = await dependencies.finalizeGuideDelivery(delivery.id, delivery.claimToken);
        return result === "completed" ? "completed" : "already_processing";
      }
      await dependencies.sleep(STEP_DELAY_MS);
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
      claimExpiresAt: new Date(claimAt.getTime() + dependencies.claimLeaseMs),
    });
    if (!claimed) {
      return "already_processing";
    }
    return processClaimedGuideDelivery(claimed);
  };

  return Object.assign(deliverGuideForTrigger, {
    processClaimedGuideDelivery,
  });
}

async function loadCurrentResourceMessages(resourceId: string): Promise<AuthoredGuideMessage[]> {
  return prisma.resourceMessage.findMany({
    where: { resourceId },
    orderBy: { order: "asc" },
    select: { id: true, order: true, type: true, body: true, mediaUrl: true },
  });
}

const defaultRepository: GuideDeliveryServiceRepository = {
  findByTrigger(input) {
    return prisma.guideDelivery.findUnique({
      where: {
        triggerKind_triggerId: {
          triggerKind: input.triggerKind,
          triggerId: input.triggerId,
        },
      },
      include: { units: { orderBy: { position: "asc" } } },
    });
  },
  async findRecipientIgUserId(deliveryId) {
    const delivery = await prisma.guideDelivery.findUnique({
      where: { id: deliveryId },
      select: { conversation: { select: { igUserId: true } } },
    });
    return delivery?.conversation.igUserId ?? null;
  },
  createOrLoadPlan: (input) => guideDeliveryRepository.createOrLoadPlan(input),
  claimById: (input) => guideDeliveryRepository.claimById(input),
  beginUnit: (input) => guideDeliveryRepository.beginUnit(input),
  markUnitSent: (input) => guideDeliveryRepository.markUnitSent(input),
  markUnitRetryable: (input) => guideDeliveryRepository.markUnitRetryable(input),
  markUnitFailed: (input) => guideDeliveryRepository.markUnitFailed(input),
  markUnitUncertain: (input) => guideDeliveryRepository.markUnitUncertain(input),
  markWindowClosed: (input) => guideDeliveryRepository.markWindowClosed(input),
  releaseClaim: (input) => guideDeliveryRepository.releaseClaim(input),
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultService = createGuideDeliveryService({
  repository: defaultRepository,
  loadResourceMessages: loadCurrentResourceMessages,
  sendText: sendTrackedText,
  sendMedia: sendTrackedMedia,
  finalizeGuideDelivery,
  sleep,
  now: () => new Date(),
  logger,
  maxAttempts: env.GUIDE_DELIVERY_MAX_ATTEMPTS,
  claimLeaseMs: env.GUIDE_DELIVERY_LEASE_MS,
  retryDelayMs: env.GUIDE_DELIVERY_RETRY_BASE_MS,
});

export const deliverGuideForTrigger = defaultService;
export const processClaimedGuideDelivery = defaultService.processClaimedGuideDelivery;
