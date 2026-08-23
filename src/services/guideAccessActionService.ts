import type { GuideAccessAttempt, GuideAccessAttemptState } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  sendGuideFollowerGate,
  sendGuideFollowLag,
  sendGuideInitialPrivateReply,
  type GuideActionCapabilities,
} from "../meta/sendGuideAction.js";
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
import { guideRichGateEnabled } from "./guideFollowGateV2Rollout.js";

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
  | "access_attempt_needs_review"
  | "guide_opening_sent"
  | "guide_opening_already_sent"
  | "guide_opening_failed";

/**
 * A comment opens a journey; it never authorizes one. Meta allows a single
 * private reply per comment, so this request carries the comment id only as a
 * send target — never as authorization evidence, and never as a token.
 */
export type CommentGuideRequest = {
  conversationId: string;
  igUserId: string;
  resourceId: string;
  commentId: string;
  observedAt: Date;
  messagingWindowExpiresAt?: Date;
};

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
  sendFollowLag(input: {
    recipientId: string;
    actionToken: string;
  }): Promise<MetaSendResult>;
  sendInitialPrivateReply(input: {
    commentId: string;
    guideName: string;
    actionToken: string;
    capabilities: GuideActionCapabilities;
  }): Promise<MetaSendResult>;
  /**
   * Read per outbound action so an operator stop takes effect immediately. Rich
   * controls stay off until the reviewed capability rows say otherwise.
   */
  richCapabilities(): GuideActionCapabilities;
  loadGuideName(resourceId: string): Promise<string>;
  loadThreadId(inboundMessageId: string): Promise<string | null>;
  findAttemptIdByToken(tokenId: string): Promise<string | null>;
  logger: {
    error(bindings: Record<string, unknown>, message: string): void;
  };
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

type ReviewCheckpoint = {
  outcome: GuideAccessActionOutcome;
  durable: boolean;
};

type ReviewableAttemptState = Exclude<
  GuideAccessAttemptState,
  "delivered" | "expired"
>;

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

/**
 * A review reached WITHOUT a definitive follow answer is the parent's fault-free
 * case: `handleUnavailable` told them "Please try again a little later", so their
 * next reply must be able to re-check. Re-entry stays bounded by
 * MAX_FOLLOW_CHECKS inside `claimDirectInbound`.
 *
 * A review that already holds a definitive answer stays terminal on purpose — the
 * two-response follow-lag limit, or a fault once delivery had begun. Those belong
 * to the owner, not to another automatic attempt.
 */
function isRetryableReview(attempt: GuideAccessAttempt): boolean {
  return attempt.state === "needs_review" && attempt.lastFollowResult === "unknown";
}

export function createGuideAccessActionService(
  dependencies: GuideAccessActionDependencies,
) {
  validateDependencies(dependencies);

  async function checkpointNeedsReview(
    attemptId: string,
    candidateStates: ReviewableAttemptState | readonly ReviewableAttemptState[],
    errorCode: string,
    checkedAt?: Date,
  ): Promise<ReviewCheckpoint> {
    const candidates = [
      ...new Set(
        typeof candidateStates === "string" ? [candidateStates] : candidateStates,
      ),
    ];
    const pending = [...candidates];
    const attempts = new Map<ReviewableAttemptState, number>();

    while (pending.length > 0) {
      const expectedState = pending.shift()!;
      const priorAttempts = attempts.get(expectedState) ?? 0;
      if (priorAttempts >= 2) continue;
      const attemptNumber = priorAttempts + 1;
      attempts.set(expectedState, attemptNumber);
      try {
        const result = await dependencies.repository.markNeedsReview({
          attemptId,
          expectedState,
          ...(checkedAt ? { checkedAt } : {}),
        });
        if (result.kind === "transitioned") {
          return { outcome: "access_attempt_needs_review", durable: true };
        }
        if (result.kind === "state_conflict" && result.actualState === "needs_review") {
          return { outcome: "access_attempt_needs_review", durable: true };
        }
        if (result.kind === "state_conflict") {
          if (result.actualState === "delivered" || result.actualState === "expired") {
            return { outcome: outcomeForState(result.actualState), durable: false };
          }
          if (
            candidates.includes(result.actualState) &&
            (attempts.get(result.actualState) ?? 0) < 2
          ) {
            const duplicate = pending.indexOf(result.actualState);
            if (duplicate >= 0) pending.splice(duplicate, 1);
            pending.unshift(result.actualState);
            continue;
          }
          break;
        }
        if (result.kind === "expired") {
          return { outcome: "action_expired", durable: false };
        }
        break;
      } catch {
        // Each candidate is tried at most twice. A retry can observe a
        // needs_review commit whose acknowledgement was lost without repeating
        // Graph, Meta, or durable delivery work.
        if (attemptNumber < 2) pending.unshift(expectedState);
      }
    }
    dependencies.logger.error(
      { errorCode: "guide_access_review_checkpoint_failed", stage: errorCode, attemptId },
      "Guide access review checkpoint failed",
    );
    return { outcome: "access_attempt_needs_review", durable: false };
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
      await checkpointNeedsReview(
        attemptId,
        expectedState,
        "provider_outcome_uncertain",
      );
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
      await checkpointNeedsReview(
        context.attempt.id,
        "checking_follow",
        "guide_context_load_failed",
      );
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
      await checkpointNeedsReview(
        context.attempt.id,
        "delivering",
        "thread_context_load_failed",
      );
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

    let result;
    try {
      result = await dependencies.repository.replaceToken({
        attemptId: attempt.id,
        action: "check_follow",
        expectedState: "checking_follow",
        now,
        expiresAt,
      });
    } catch {
      const review = await checkpointNeedsReview(
        attempt.id,
        "checking_follow",
        "follow_token_replacement_failed",
      );
      return { kind: "outcome", outcome: review.outcome };
    }
    if (result.kind === "issued") return { kind: "ready", tokenId: result.token.id };
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
    const review = await checkpointNeedsReview(
      context.attempt.id,
      "checking_follow",
      "follow_check_unavailable",
      checkedAt,
    );
    if (!review.durable) return review.outcome;

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

    if (context.falseResponse === "lag") {
      let reservation;
      try {
        reservation = await dependencies.repository.reserveFollowResponse({
          attemptId: context.attempt.id,
          expectedState: "checking_follow",
          now,
        });
      } catch {
        const review = await checkpointNeedsReview(
          context.attempt.id,
          "checking_follow",
          "follow_response_reservation_failed",
          checkedAt,
        );
        return review.outcome;
      }
      if (reservation.kind !== "reserved") {
        if (reservation.kind === "expired") return "action_expired";
        if (reservation.kind === "state_conflict") {
          return outcomeForState(reservation.actualState);
        }
        if (reservation.kind === "limit_reached") {
          const review = await checkpointNeedsReview(
            context.attempt.id,
            "checking_follow",
            "follow_response_limit_reached",
            checkedAt,
          );
          return review.outcome;
        }
        return "action_consumed";
      }
    }

    let guideName: string | null = null;
    if (context.falseResponse === "gate") {
      guideName = await loadGuideName(context);
      if (guideName === null) return "access_attempt_needs_review";
    }

    const issued = await issueFollowToken(context.attempt, now);
    if (issued.kind === "outcome") return issued.outcome;

    let send: () => Promise<MetaSendResult>;
    if (context.falseResponse === "lag") {
      send = () =>
        dependencies.sendFollowLag({
          recipientId: context.senderId,
          actionToken: issued.tokenId,
        });
    } else {
      send = () =>
        dependencies.sendFollowerGate({
          recipientId: context.senderId,
          guideName: guideName!,
          actionToken: issued.tokenId,
        });
    }

    const sendResult = await sendAfterFence(context.attempt.id, "checking_follow", send);
    if (sendResult === "needs_review") return "access_attempt_needs_review";

    let awaiting;
    try {
      awaiting = await dependencies.repository.markAwaitingFollow({
        attemptId: context.attempt.id,
        expectedState: "checking_follow",
        checkedAt,
        now: dependencies.now(),
      });
    } catch {
      const review = await checkpointNeedsReview(
        context.attempt.id,
        ["checking_follow", "awaiting_follow"],
        "awaiting_follow_checkpoint_failed",
        checkedAt,
      );
      return review.outcome;
    }
    if (awaiting.kind !== "transitioned") return outcomeForTransition(awaiting);

    if (sendResult === "definite_failure") return "action_consumed";
    return "follow_not_confirmed";
  }

  async function handleFollower(
    context: AuthorizationContext,
    checkedAt: Date,
  ): Promise<GuideAccessActionOutcome> {
    let delivering;
    try {
      delivering = await dependencies.repository.markDelivering({
        attemptId: context.attempt.id,
        expectedState: "checking_follow",
        checkedAt,
        now: dependencies.now(),
      });
    } catch {
      const review = await checkpointNeedsReview(
        context.attempt.id,
        ["checking_follow", "delivering"],
        "delivering_claim_failed",
        checkedAt,
      );
      return review.outcome;
    }
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
      const review = await checkpointNeedsReview(
        context.attempt.id,
        "delivering",
        "durable_delivery_start_failed",
        checkedAt,
      );
      return review.outcome;
    }

    if (deliveryResult === "already_processing") {
      return "guide_delivery_already_started";
    }
    if (deliveryResult === "needs_review" || deliveryResult === "preflight_failed") {
      const review = await checkpointNeedsReview(
        context.attempt.id,
        "delivering",
        "durable_delivery_needs_review",
        checkedAt,
      );
      return review.outcome;
    }
    if (deliveryResult === "completed") {
      let delivered;
      try {
        delivered = await dependencies.repository.markDelivered({
          attemptId: context.attempt.id,
          expectedState: "delivering",
        });
      } catch {
        const review = await checkpointNeedsReview(
          context.attempt.id,
          "delivering",
          "delivered_checkpoint_failed",
          checkedAt,
        );
        return review.outcome;
      }
      if (delivered.kind !== "transitioned") return outcomeForTransition(delivered);
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
    let consumed;
    try {
      consumed = await dependencies.repository.consumeToken({
        tokenId,
        action,
        senderId,
        now: dependencies.now(),
      });
    } catch {
      let attemptId: string | null;
      try {
        attemptId = await dependencies.findAttemptIdByToken(tokenId);
      } catch {
        dependencies.logger.error(
          { errorCode: "guide_action_consumption_reconciliation_failed" },
          "Guide action consumption reconciliation failed",
        );
        return "access_attempt_needs_review";
      }
      if (!attemptId) {
        dependencies.logger.error(
          { errorCode: "guide_action_consumption_reconciliation_failed" },
          "Guide action consumption reconciliation failed",
        );
        return "access_attempt_needs_review";
      }
      const review = await checkpointNeedsReview(
        attemptId,
        [
          action === "request_guide" ? "awaiting_request" : "awaiting_follow",
          "checking_follow",
        ],
        "action_consumption_failed",
      );
      return review.outcome;
    }

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
      let attemptId: string | null;
      try {
        attemptId = await dependencies.findAttemptIdByToken(tokenId);
      } catch {
        dependencies.logger.error(
          { errorCode: "guide_action_limit_lookup_failed" },
          "Guide action limit lookup failed",
        );
        return "access_attempt_needs_review";
      }
      if (!attemptId) return "action_expired";
      const review = await checkpointNeedsReview(
        attemptId,
        "awaiting_follow",
        "follow_check_limit_reached",
        dependencies.now(),
      );
      return review.outcome;
    }

    try {
      return await authorizeClaimed({
        attempt: consumed.attempt,
        senderId,
        triggerKind: action === "check_follow" ? "follow_recovery" : "inbound_reply",
        triggerId: action === "check_follow" ? tokenId : inboundMessageId,
        threadLookupId: inboundMessageId,
        triggeredAt: eventAt,
        falseResponse: action === "check_follow" ? "lag" : "gate",
      });
    } catch {
      const review = await checkpointNeedsReview(
        consumed.attempt.id,
        ["checking_follow", "awaiting_follow", "delivering"],
        "post_consumption_orchestration_failed",
      );
      return review.outcome;
    }
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
    try {
      if (await dependencies.findAttemptIdByToken(inbound.id)) {
        return "action_replayed";
      }
    } catch {
      dependencies.logger.error(
        { errorCode: "direct_inbound_replay_lookup_failed" },
        "Direct guide inbound replay lookup failed",
      );
      return "access_attempt_needs_review";
    }

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
      attempt.state === "expired" ||
      (attempt.state === "needs_review" && !isRetryableReview(attempt))
    ) {
      return outcomeForState(attempt.state);
    }

    let checking;
    try {
      checking = await dependencies.repository.claimDirectInbound({
        attemptId: attempt.id,
        inboundMessageId: inbound.id,
        now,
      });
    } catch {
      const review = await checkpointNeedsReview(
        attempt.id,
        [attempt.state, "checking_follow"],
        "direct_inbound_claim_failed",
      );
      return review.outcome;
    }
    if (checking.kind === "already_consumed" || checking.kind === "token_conflict") {
      return "action_replayed";
    }
    if (checking.kind === "expired") return "action_expired";
    if (checking.kind === "attempt_not_found") return "action_expired";
    if (checking.kind === "check_limit_reached") {
      const review = await checkpointNeedsReview(
        attempt.id,
        attempt.state,
        "direct_follow_check_limit_reached",
        now,
      );
      return review.outcome;
    }
    if (checking.kind === "state_conflict") return outcomeForState(checking.actualState);

    try {
      return await authorizeClaimed({
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
    } catch {
      const review = await checkpointNeedsReview(
        attempt.id,
        ["checking_follow", "awaiting_follow", "delivering"],
        "post_direct_claim_orchestration_failed",
      );
      return review.outcome;
    }
  }

  async function startCommentGuideRequest(
    input: CommentGuideRequest,
  ): Promise<GuideAccessActionOutcome> {
    const now = dependencies.now();
    const windowExpiresAt =
      input.messagingWindowExpiresAt ??
      new Date(input.observedAt.getTime() + STANDARD_DM_WINDOW_MS);

    // The repository accepts any window and cannot reject an already-closed one
    // (deferred at Task 3), so the caller owns that check. Opening into a closed
    // window would spend the single private reply Meta allows for this comment
    // on a message the parent can never act on.
    if (windowExpiresAt.getTime() <= now.getTime()) return "action_expired";

    let created;
    try {
      created = await dependencies.repository.createOrLoadAttempt({
        conversationId: input.conversationId,
        resourceId: input.resourceId,
        coverVersionId: null,
        messagingWindowExpiresAt: windowExpiresAt,
        now,
      });
    } catch {
      dependencies.logger.error(
        { errorCode: "comment_attempt_create_failed" },
        "Guide access comment attempt creation failed",
      );
      return "access_attempt_needs_review";
    }

    const attempt = created.attempt;
    // Any other state means this journey already moved past its opening. The
    // parent's own action owns every later transition.
    if (attempt.state !== "awaiting_request") return outcomeForState(attempt.state);

    let guideName: string;
    try {
      guideName = await dependencies.loadGuideName(attempt.resourceId);
    } catch {
      dependencies.logger.error(
        { errorCode: "comment_guide_context_load_failed", attemptId: attempt.id },
        "Guide access comment context load failed",
      );
      return "access_attempt_needs_review";
    }

    let issued;
    try {
      issued = await dependencies.repository.issueToken({
        attemptId: attempt.id,
        action: "request_guide",
        now,
        expiresAt: tokenExpiry(now, windowExpiresAt, dependencies.actionTokenTtlMs),
      });
    } catch {
      dependencies.logger.error(
        { errorCode: "comment_request_token_issue_failed", attemptId: attempt.id },
        "Guide access comment token issue failed",
      );
      return "access_attempt_needs_review";
    }

    if (issued.kind === "attempt_not_found" || issued.kind === "attempt_expired") {
      return "action_expired";
    }
    if (issued.kind === "state_conflict") return outcomeForState(issued.actualState);
    // A replayed token means this journey already owns an opening. A second
    // comment must not produce a second private reply.
    if (issued.kind === "replayed") return "guide_opening_already_sent";

    const capabilities = dependencies.richCapabilities();
    const disposition = await sendAfterFence(attempt.id, "awaiting_request", () =>
      dependencies.sendInitialPrivateReply({
        commentId: input.commentId,
        guideName,
        actionToken: issued.token.id,
        capabilities,
      }),
    );
    if (disposition === "sent") return "guide_opening_sent";
    if (disposition === "needs_review") return "access_attempt_needs_review";

    // Definitely not delivered. The attempt stays openable rather than being
    // escalated as ambiguous, and no second private reply is attempted.
    dependencies.logger.error(
      { errorCode: "comment_opening_send_failed", attemptId: attempt.id },
      "Guide access comment opening failed",
    );
    return "guide_opening_failed";
  }

  return {
    requestGuideFromAction,
    checkFollowFromAction,
    startDirectDmGuideRequest,
    startCommentGuideRequest,
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
  sendFollowLag: sendGuideFollowLag,
  sendInitialPrivateReply: sendGuideInitialPrivateReply,
  // The switch is the operator's assertion that the reviewed capability rows are
  // `supported`; it is read per action so a stop applies to the next opening.
  richCapabilities: () =>
    guideRichGateEnabled()
      ? { privateQuickReply: true, dmGenericGate: true, dmQuickReply: true }
      : { privateQuickReply: false, dmGenericGate: false, dmQuickReply: false },
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
  logger,
});

export const requestGuideFromAction = defaultService.requestGuideFromAction;
export const checkFollowFromAction = defaultService.checkFollowFromAction;
export const startDirectDmGuideRequest = defaultService.startDirectDmGuideRequest;
export const startCommentGuideRequest = defaultService.startCommentGuideRequest;
