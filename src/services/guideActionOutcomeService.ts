import type { GuideAccessAttempt, GuideActionTokenAction } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  sendGuideRecoveryAction,
  type GuideActionCapabilities,
} from "../meta/sendGuideAction.js";
import type { MetaSendResult } from "../types/meta.js";
import { sendTrackedText } from "./dmDeliveryService.js";
import type { GuideAccessActionOutcome } from "./guideAccessActionService.js";
import { guideAccessCopy } from "./guideAccessCopy.js";
import { GUIDE_ACCESS_WINDOW_MS } from "./guideAccessPolicy.js";
import {
  guideAccessRepository,
  type CreateGuideAccessAttemptResult,
  type GuideAccessRepository,
  type GuideAccessTransitionResult,
  type IssueGuideActionTokenResult,
} from "./guideAccessRepository.js";
import { guideRichGateEnabled } from "./guideFollowGateV2Rollout.js";

export type GuideActionOutcomePresentation =
  | "none_duplicate_webhook"
  | "none_invalid_action"
  | "none_audience_policy"
  | "guide_flow_continued"
  | "fresh_opening_sent"
  | "fresh_follow_action_sent"
  | "already_delivered_notice_sent"
  | "review_notice_sent"
  | "needs_review";

export type GuideActionPresentableOutcome =
  | GuideAccessActionOutcome
  | "duplicate_event"
  | "action_invalid";

type GuideActionContext = {
  attempt: GuideAccessAttempt;
  senderId: string;
};

export type GuideActionOutcomeDependencies = {
  loadContext(tokenId: string): Promise<GuideActionContext | null>;
  createOrLoadAttempt: GuideAccessRepository["createOrLoadAttempt"];
  issueToken(input: Parameters<GuideAccessRepository["issueToken"]>[0]): Promise<IssueGuideActionTokenResult>;
  markNeedsReview(
    input: Parameters<GuideAccessRepository["markNeedsReview"]>[0],
  ): Promise<GuideAccessTransitionResult>;
  sendRecoveryAction(input: {
    recipientId: string;
    action: GuideActionTokenAction;
    actionToken: string;
    capabilities: GuideActionCapabilities;
  }): Promise<MetaSendResult>;
  sendText(input: { recipientId: string; text: string }): Promise<MetaSendResult>;
  capabilities(): GuideActionCapabilities;
  now(): Date;
  logger: {
    error(bindings: Record<string, unknown>, message: string): void;
  };
};

export type PresentGuideActionOutcomeInput = {
  eventId: string;
  tokenId: string;
  senderId: string;
  action: GuideActionTokenAction;
  outcome: GuideActionPresentableOutcome;
  eventAt: Date;
};

function actionForState(attempt: GuideAccessAttempt): GuideActionTokenAction | null {
  if (attempt.state === "awaiting_request") return "request_guide";
  if (attempt.state === "awaiting_follow") return "check_follow";
  return null;
}

export function createGuideActionOutcomeService(
  dependencies: GuideActionOutcomeDependencies,
) {
  async function loadBoundContext(
    tokenId: string,
    senderId: string,
  ): Promise<GuideActionContext | null> {
    try {
      const context = await dependencies.loadContext(tokenId);
      return context?.senderId === senderId ? context : null;
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_action_presentation_context_failed" },
        "Guide action presentation context could not be loaded",
      );
      return null;
    }
  }

  async function sendNotice(
    senderId: string,
    text: string,
    success: GuideActionOutcomePresentation,
  ): Promise<GuideActionOutcomePresentation> {
    try {
      const receipt = await dependencies.sendText({ recipientId: senderId, text });
      return receipt.messageId ? success : "needs_review";
    } catch {
      return "needs_review";
    }
  }

  async function markSendUncertain(attempt: GuideAccessAttempt): Promise<void> {
    if (attempt.state === "delivered" || attempt.state === "expired") return;
    try {
      await dependencies.markNeedsReview({
        attemptId: attempt.id,
        expectedState: attempt.state,
      });
    } catch {
      dependencies.logger.error(
        { errorCode: "guide_action_recovery_review_failed", attemptId: attempt.id },
        "Guide action recovery could not be marked for review",
      );
    }
  }

  async function refreshAction(
    context: GuideActionContext,
    action: GuideActionTokenAction,
  ): Promise<GuideActionOutcomePresentation> {
    const now = dependencies.now();
    let issued: IssueGuideActionTokenResult;
    try {
      issued = await dependencies.issueToken({
        attemptId: context.attempt.id,
        action,
        now,
        expiresAt: context.attempt.messagingWindowExpiresAt,
      });
    } catch {
      await markSendUncertain(context.attempt);
      return "needs_review";
    }
    if (issued.kind !== "issued" && issued.kind !== "replayed") {
      await markSendUncertain(context.attempt);
      return "needs_review";
    }

    try {
      const receipt = await dependencies.sendRecoveryAction({
        recipientId: context.senderId,
        action,
        actionToken: issued.token.id,
        capabilities: dependencies.capabilities(),
      });
      if (!receipt.messageId) {
        await markSendUncertain(context.attempt);
        return "needs_review";
      }
    } catch {
      await markSendUncertain(context.attempt);
      return "needs_review";
    }
    return action === "request_guide" ? "fresh_opening_sent" : "fresh_follow_action_sent";
  }

  return async function presentGuideActionOutcome(
    input: PresentGuideActionOutcomeInput,
  ): Promise<GuideActionOutcomePresentation> {
    if (input.outcome === "duplicate_event") return "none_duplicate_webhook";
    if (input.outcome === "action_invalid") return "none_invalid_action";
    if (input.outcome === "guide_audience_blocked") return "none_audience_policy";

    const requiresPresentation =
      input.outcome === "action_expired" ||
      input.outcome === "action_replayed" ||
      input.outcome === "guide_delivery_already_started" ||
      input.outcome === "access_attempt_needs_review";
    if (!requiresPresentation) return "guide_flow_continued";

    let context = await loadBoundContext(input.tokenId, input.senderId);
    if (!context) return "none_invalid_action";

    if (
      input.outcome === "guide_delivery_already_started" ||
      context.attempt.state === "delivering" ||
      context.attempt.state === "delivered"
    ) {
      return sendNotice(
        input.senderId,
        guideAccessCopy.alreadyDelivered,
        "already_delivered_notice_sent",
      );
    }
    if (
      input.outcome === "access_attempt_needs_review" ||
      context.attempt.state === "needs_review"
    ) {
      return sendNotice(
        input.senderId,
        guideAccessCopy.reviewRequired,
        "review_notice_sent",
      );
    }
    if (context.attempt.state === "checking_follow") {
      return sendNotice(input.senderId, guideAccessCopy.checking, "guide_flow_continued");
    }

    if (context.attempt.state === "expired") {
      let reopened: CreateGuideAccessAttemptResult;
      try {
        reopened = await dependencies.createOrLoadAttempt({
          conversationId: context.attempt.conversationId,
          resourceId: context.attempt.resourceId,
          messagingWindowExpiresAt: new Date(input.eventAt.getTime() + GUIDE_ACCESS_WINDOW_MS),
          now: dependencies.now(),
        });
      } catch {
        return "needs_review";
      }
      context = { ...context, attempt: reopened.attempt };
    }

    const nextAction = actionForState(context.attempt);
    if (!nextAction) {
      return sendNotice(
        input.senderId,
        guideAccessCopy.reviewRequired,
        "review_notice_sent",
      );
    }
    return refreshAction(context, nextAction);
  };
}

const defaultService = createGuideActionOutcomeService({
  async loadContext(tokenId) {
    const token = await prisma.guideActionToken.findUnique({
      where: { id: tokenId },
      select: {
        attempt: {
          include: {
            conversation: { select: { igUserId: true } },
          },
        },
      },
    });
    if (!token) return null;
    const { conversation, ...attempt } = token.attempt;
    return { attempt, senderId: conversation.igUserId };
  },
  createOrLoadAttempt: (input) => guideAccessRepository.createOrLoadAttempt(input),
  issueToken: (input) => guideAccessRepository.issueToken(input),
  markNeedsReview: (input) => guideAccessRepository.markNeedsReview(input),
  sendRecoveryAction: sendGuideRecoveryAction,
  sendText: (input) =>
    sendTrackedText({
      recipientIgUserId: input.recipientId,
      text: input.text,
      source: "keyword_automation",
    }),
  capabilities: () =>
    guideRichGateEnabled()
      ? {
          privateQuickReply: true,
          dmGenericGate: true,
          dmQuickReply: true,
          privateGeneric: true,
        }
      : {
          privateQuickReply: false,
          dmGenericGate: false,
          dmQuickReply: false,
          privateGeneric: false,
        },
  now: () => new Date(),
  logger,
});

export const presentGuideActionOutcome = defaultService;
