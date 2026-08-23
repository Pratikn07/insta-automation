import type { GuideAccessAttempt, GuideAccessAttemptState } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendGuideFollowerGate } from "../meta/sendGuideAction.js";
import type { MetaSendResult } from "../types/meta.js";
import { sendTrackedText } from "./dmDeliveryService.js";
import { describeGraphError } from "./eventLogger.js";
import { resolveFollowStatusFresh, type FreshFollowResult } from "./freshFollowVerifier.js";
import { classifyDirectMessageSend } from "./graphErrorClassifier.js";
import { guideAccessCopy } from "./guideAccessCopy.js";
import {
  guideAccessRepository,
  type GuideAccessRepository,
  type GuideAccessTransitionResult,
} from "./guideAccessRepository.js";
import {
  deliverGuideForTrigger,
  type DeliverGuideForTriggerInput,
  type GuideDeliveryResult,
} from "./guideDeliveryService.js";

const STANDARD_DM_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ACTION_TOKEN_TTL_MS = 10 * 60 * 1_000;

export type GuideAccessActionOutcome =
  | "action_consumed"
  | "action_replayed"
  | "action_expired"
  | "follow_confirmed"
  | "follow_not_confirmed"
  | "follow_check_unavailable"
  | "guide_delivery_started"
  | "guide_delivery_already_started"
  | "access_attempt_needs_review";

export type DirectDmGuideConversation = {
  id: string;
  igUserId: string;
  resourceId: string;
  guideName: string;
  coverVersionId?: string | null;
  /** Metadata is accepted but never used as authorization evidence. */
  createdAt?: Date;
  deliveryTriggerKind?: "inbound_reply" | "explicit_redelivery";
  redeliveryIntro?: string;
};

export type DirectDmGuideInbound = {
  /** Internal persisted DmMessage UUID, never Meta text or provider `mid`. */
  id: string;
  threadId: string | null;
  eventAt: Date;
  messagingWindowExpiresAt?: Date;
};

type ActionKind = "request_guide" | "check_follow";

export type GuideAccessActionDependencies = {
  repository: GuideAccessRepository;
  resolveFollowStatusFresh(igUserId: string): Promise<FreshFollowResult>;
  startGuideDelivery(input: DeliverGuideForTriggerInput): Promise<GuideDeliveryResult>;
  sendFollowerGate(input: {
    recipientId: string;
    guideName: string;
    actionToken: string;
  }): Promise<MetaSendResult>;
  sendText(input: { recipientId: string; text: string }): Promise<MetaSendResult>;
  loadGuideName(resourceId: string): Promise<string>;
  loadThreadId(inboundMessageId: string): Promise<string | null>;
  findAttemptIdByToken(tokenId: string): Promise<string | null>;
  now(): Date;
  actionTokenTtlMs: number;
};

type AuthorizationContext = {
  attempt: GuideAccessAttempt;
  senderId: string;
  triggerKind: "inbound_reply" | "explicit_redelivery" | "follow_recovery";
  triggerId: string;
  threadLookupId: string;
  triggeredAt: Date;
  falseResponse: "gate" | "lag";
  guideName?: string;
  threadId?: string | null;
  redeliveryIntro?: string;
};

function validateDependencies(dependencies: GuideAccessActionDependencies): void {
  if (
    !Number.isFinite(dependencies.actionTokenTtlMs) ||
    dependencies.actionTokenTtlMs <= 0
  ) {
    throw new Error("invalid guide action token ttl");
  }
}

function outcomeForState(state: GuideAccessAttemptState): GuideAccessActionOutcome {
  if (state === "delivering" || state === "delivered") {
    return "guide_delivery_already_started";
  }
  if (state === "needs_review") return "access_attempt_needs_review";
  if (state === "expired") return "action_expired";
  return "action_replayed";
}

function outcomeForTransition(
  result: Exclude<GuideAccessTransitionResult, { kind: "transitioned" }>,
): GuideAccessActionOutcome {
  if (result.kind === "expired") return "action_expired";
  if (result.kind === "state_conflict") return outcomeForState(result.actualState);
  return "action_consumed";
}

function tokenExpiry(now: Date, windowExpiresAt: Date, ttlMs: number): Date {
  return new Date(Math.min(now.getTime() + ttlMs, windowExpiresAt.getTime()));
}

export function createGuideAccessActionService(
  dependencies: GuideAccessActionDependencies,
) {
  validateDependencies(dependencies);

  async function markNeedsReview(
    attemptId: string,
    expectedState: Exclude<GuideAccessAttemptState, "delivered" | "expired">,
    checkedAt?: Date,
  ): Promise<GuideAccessActionOutcome> {
    const result = await dependencies.repository.markNeedsReview({
      attemptId,
      expectedState,
      ...(checkedAt ? { checkedAt } : {}),
    });
    if (result.kind === "transitioned") return "access_attempt_needs_review";
    return outcomeForTransition(result);
  }

  async function sendAfterFence(
    attemptId: string,
    expectedState: Exclude<GuideAccessAttemptState, "delivered" | "expired">,
    send: () => Promise<MetaSendResult>,
  ): Promise<"sent" | "definite_failure" | "needs_review"> {
    try {
      const receipt = await send();
      if (receipt.messageId) return "sent";
    } catch (error) {
      const disposition = classifyDirectMessageSend(describeGraphError(error));
      if (disposition !== "uncertain") return "definite_failure";
    }

    if (expectedState !== "needs_review") {
      await markNeedsReview(attemptId, expectedState);
    }
    return "needs_review";
  }

  async function loadGuideName(
    context: AuthorizationContext,
  ): Promise<string | null> {
    if (context.guideName !== undefined) return context.guideName;
    try {
      return await dependencies.loadGuideName(context.attempt.resourceId);
    } catch {
      await markNeedsReview(context.attempt.id, "awaiting_follow");
      return null;
    }
  }

  async function loadThreadId(
    context: AuthorizationContext,
  ): Promise<{ ok: true; threadId: string | null } | { ok: false }> {
    if (context.threadId !== undefined) return { ok: true, threadId: context.threadId };
    try {
      return { ok: true, threadId: await dependencies.loadThreadId(context.threadLookupId) };
    } catch {
      await markNeedsReview(context.attempt.id, "delivering");
      return { ok: false };
    }
  }

  async function issueFollowToken(
    attempt: GuideAccessAttempt,
    now: Date,
  ): Promise<
    | { kind: "ready"; tokenId: string }
    | { kind: "outcome"; outcome: GuideAccessActionOutcome }
  > {
    const expiresAt = tokenExpiry(
      now,
      attempt.messagingWindowExpiresAt,
      dependencies.actionTokenTtlMs,
    );
    if (expiresAt <= now) return { kind: "outcome", outcome: "action_expired" };

    const result = await dependencies.repository.issueToken({
      attemptId: attempt.id,
      action: "check_follow",
      now,
      expiresAt,
    });
    if (result.kind === "issued" || result.kind === "replayed") {
      return { kind: "ready", tokenId: result.token.id };
    }
    if (result.kind === "attempt_expired") {
      return { kind: "outcome", outcome: "action_expired" };
    }
    if (result.kind === "state_conflict") {
      return { kind: "outcome", outcome: outcomeForState(result.actualState) };
    }
    return { kind: "outcome", outcome: "action_consumed" };
  }

  async function handleUnavailable(
    context: AuthorizationContext,
    checkedAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    const review = await dependencies.repository.markNeedsReview({
      attemptId: context.attempt.id,
      expectedState: "checking_follow",
      checkedAt,
    });
    if (review.kind !== "transitioned") return outcomeForTransition(review);

    const sendResult = await sendAfterFence(
      context.attempt.id,
      "needs_review",
      () =>
        dependencies.sendText({
          recipientId: context.senderId,
          text: guideAccessCopy.unavailable,
        }),
    );
    if (sendResult === "needs_review") return "access_attempt_needs_review";
    if (sendResult === "definite_failure") return "action_consumed";
    return "follow_check_unavailable";
  }

  async function handleNonFollower(
    context: AuthorizationContext,
    checkedAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    const now = dependencies.now();
    const awaiting = await dependencies.repository.markAwaitingFollow({
      attemptId: context.attempt.id,
      expectedState: "checking_follow",
      checkedAt,
      now,
    });
    if (awaiting.kind !== "transitioned") return outcomeForTransition(awaiting);

    if (context.falseResponse === "lag") {
      const reservation = await dependencies.repository.reserveFollowResponse({
        attemptId: context.attempt.id,
        expectedState: "awaiting_follow",
        now,
      });
      if (reservation.kind !== "reserved") {
        if (reservation.kind === "expired") return "action_expired";
        if (reservation.kind === "state_conflict") {
          return outcomeForState(reservation.actualState);
        }
        if (reservation.kind === "limit_reached") {
          return markNeedsReview(context.attempt.id, "awaiting_follow", checkedAt);
        }
        return "action_consumed";
      }
    }

    const issued = await issueFollowToken(awaiting.attempt, now);
    if (issued.kind === "outcome") return issued.outcome;

    let send: () => Promise<MetaSendResult>;
    if (context.falseResponse === "lag") {
      send = () =>
        dependencies.sendText({
          recipientId: context.senderId,
          text: guideAccessCopy.followLag,
        });
    } else {
      const guideName = await loadGuideName({ ...context, attempt: awaiting.attempt });
      if (guideName === null) return "access_attempt_needs_review";
      send = () =>
        dependencies.sendFollowerGate({
          recipientId: context.senderId,
          guideName,
          actionToken: issued.tokenId,
        });
    }

    const sendResult = await sendAfterFence(context.attempt.id, "awaiting_follow", send);
    if (sendResult === "needs_review") return "access_attempt_needs_review";
    if (sendResult === "definite_failure") return "action_consumed";
    return "follow_not_confirmed";
  }

  async function handleFollower(
    context: AuthorizationContext,
    checkedAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    const delivering = await dependencies.repository.markDelivering({
      attemptId: context.attempt.id,
      expectedState: "checking_follow",
      checkedAt,
      now: dependencies.now(),
    });
    if (delivering.kind !== "transitioned") return outcomeForTransition(delivering);

    const thread = await loadThreadId({ ...context, attempt: delivering.attempt });
    if (!thread.ok) return "access_attempt_needs_review";

    let deliveryResult: GuideDeliveryResult;
    try {
      deliveryResult = await dependencies.startGuideDelivery({
        conversationId: delivering.attempt.conversationId,
        resourceId: delivering.attempt.resourceId,
        igUserId: context.senderId,
        threadId: thread.threadId,
        triggerKind: context.triggerKind,
        triggerId: context.triggerId,
        triggeredAt: context.triggeredAt,
        sendWindowExpiresAt: delivering.attempt.messagingWindowExpiresAt,
        followerAtTrigger: true,
        ...(context.redeliveryIntro ? { redeliveryIntro: context.redeliveryIntro } : {}),
      });
    } catch {
      return markNeedsReview(context.attempt.id, "delivering", checkedAt);
    }

    if (deliveryResult === "already_processing") {
      return "guide_delivery_already_started";
    }
    if (deliveryResult === "needs_review" || deliveryResult === "preflight_failed") {
      return markNeedsReview(context.attempt.id, "delivering", checkedAt);
    }
    return "guide_delivery_started";
  }

  async function authorizeClaimed(
    context: AuthorizationContext,
  ): Promise<GuideAccessActionOutcome> {
    let fresh: FreshFollowResult | null = null;
    try {
      fresh = await dependencies.resolveFollowStatusFresh(context.senderId);
    } catch {
      // Unexpected verifier failures are indistinguishable from unavailable at
      // this strict boundary. Cached profile data is deliberately not consulted.
    }

    if (fresh?.source === "meta_live" && fresh.isFollower === true) {
      return handleFollower(context, fresh.checkedAt);
    }
    if (fresh?.source === "meta_live" && fresh.isFollower === false) {
      return handleNonFollower(context, fresh.checkedAt);
    }
    return handleUnavailable(context, fresh?.checkedAt ?? dependencies.now());
  }

  async function consumeAction(
    action: ActionKind,
    tokenId: string,
    senderId: string,
    inboundMessageId: string,
    eventAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    const consumed = await dependencies.repository.consumeToken({
      tokenId,
      action,
      senderId,
      now: dependencies.now(),
    });

    if (consumed.kind === "already_consumed") return "action_replayed";
    if (
      consumed.kind === "not_found" ||
      consumed.kind === "wrong_sender" ||
      consumed.kind === "wrong_action" ||
      consumed.kind === "expired"
    ) {
      return "action_expired";
    }
    if (consumed.kind === "state_conflict") {
      return outcomeForState(consumed.actualState);
    }
    if (consumed.kind === "check_limit_reached") {
      const attemptId = await dependencies.findAttemptIdByToken(tokenId);
      if (!attemptId) return "action_expired";
      return markNeedsReview(attemptId, "awaiting_follow", dependencies.now());
    }

    return authorizeClaimed({
      attempt: consumed.attempt,
      senderId,
      triggerKind: action === "check_follow" ? "follow_recovery" : "inbound_reply",
      triggerId: action === "check_follow" ? tokenId : inboundMessageId,
      threadLookupId: inboundMessageId,
      triggeredAt: eventAt,
      falseResponse: action === "check_follow" ? "lag" : "gate",
    });
  }

  async function requestGuideFromAction(
    tokenId: string,
    senderId: string,
    inboundMessageId: string,
    eventAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    return consumeAction("request_guide", tokenId, senderId, inboundMessageId, eventAt);
  }

  async function checkFollowFromAction(
    tokenId: string,
    senderId: string,
    inboundMessageId: string,
    eventAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    return consumeAction("check_follow", tokenId, senderId, inboundMessageId, eventAt);
  }

  async function startDirectDmGuideRequest(
    conversation: DirectDmGuideConversation,
    inbound: DirectDmGuideInbound,
  ): Promise<GuideAccessActionOutcome> {
    const now = dependencies.now();
    const created = await dependencies.repository.createOrLoadAttempt({
      conversationId: conversation.id,
      resourceId: conversation.resourceId,
      coverVersionId: conversation.coverVersionId ?? null,
      messagingWindowExpiresAt:
        inbound.messagingWindowExpiresAt ??
        new Date(inbound.eventAt.getTime() + STANDARD_DM_WINDOW_MS),
      now,
    });
    const attempt = created.attempt;

    if (attempt.state === "checking_follow") return "action_replayed";
    if (
      attempt.state === "delivering" ||
      attempt.state === "delivered" ||
      attempt.state === "needs_review" ||
      attempt.state === "expired"
    ) {
      return outcomeForState(attempt.state);
    }

    const checking = await dependencies.repository.beginChecking({
      attemptId: attempt.id,
      expectedState: attempt.state,
      now,
    });
    if (checking.kind !== "transitioned") return outcomeForTransition(checking);

    return authorizeClaimed({
      attempt: checking.attempt,
      senderId: conversation.igUserId,
      triggerKind: conversation.deliveryTriggerKind ?? "inbound_reply",
      triggerId: inbound.id,
      threadLookupId: inbound.id,
      triggeredAt: inbound.eventAt,
      falseResponse: attempt.state === "awaiting_follow" ? "lag" : "gate",
      guideName: conversation.guideName,
      threadId: inbound.threadId,
      ...(conversation.redeliveryIntro
        ? { redeliveryIntro: conversation.redeliveryIntro }
        : {}),
    });
  }

  return {
    requestGuideFromAction,
    checkFollowFromAction,
    startDirectDmGuideRequest,
  };
}

const defaultService = createGuideAccessActionService({
  repository: guideAccessRepository,
  resolveFollowStatusFresh,
  startGuideDelivery: deliverGuideForTrigger,
  // Cover exposure is deliberately absent from this slice. The reviewed sender
  // defaults to text-only, so the placeholder is never serialized. The dependent
  // parent-delivery plan adds the separately fenced cover snapshot/exposure.
  sendFollowerGate: (input) => sendGuideFollowerGate({ ...input, coverUrl: "" }),
  sendText: (input) =>
    sendTrackedText({
      recipientIgUserId: input.recipientId,
      text: input.text,
      source: "keyword_automation",
    }),
  async loadGuideName(resourceId) {
    const resource = await prisma.resource.findUnique({
      where: { id: resourceId },
      select: { name: true },
    });
    if (!resource) throw new Error("guide access resource not found");
    return resource.name;
  },
  async loadThreadId(inboundMessageId) {
    const message = await prisma.dmMessage.findUnique({
      where: { id: inboundMessageId },
      select: { threadId: true },
    });
    return message?.threadId ?? null;
  },
  async findAttemptIdByToken(tokenId) {
    const token = await prisma.guideActionToken.findUnique({
      where: { id: tokenId },
      select: { attemptId: true },
    });
    return token?.attemptId ?? null;
  },
  now: () => new Date(),
  actionTokenTtlMs: ACTION_TOKEN_TTL_MS,
});

export const requestGuideFromAction = defaultService.requestGuideFromAction;
export const checkFollowFromAction = defaultService.checkFollowFromAction;
export const startDirectDmGuideRequest = defaultService.startDirectDmGuideRequest;
