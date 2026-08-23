import type {
  GuideAccessAttempt,
  GuideAccessAttemptState,
  GuideFollowResult,
} from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { publicMediaUrl } from "../lib/supabase.js";
import {
  sendGuideFollowerGate,
  sendGuideFollowLag,
  sendGuideInitialPrivateReply,
  type GuideActionCapabilities,
} from "../meta/sendGuideAction.js";
import type { MetaSendResult } from "../types/meta.js";
import { sendTrackedMedia, sendTrackedText } from "./dmDeliveryService.js";
import { describeGraphError } from "./eventLogger.js";
import { resolveFollowStatusFresh, type FreshFollowResult } from "./freshFollowVerifier.js";
import { classifyDirectMessageSend } from "./graphErrorClassifier.js";
import { guideAccessCopy, guideAccessOpeningText } from "./guideAccessCopy.js";
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
import { recordGuideAccessMetric } from "./guideAccessMetrics.js";
import { guideCoverDeliverySelector } from "./guideCoverDeliveryRollout.js";

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

export type CommentGuideRequestFailure = {
  /** The provider error, for the caller's existing failure classifier. */
  error: unknown;
  /**
   * The copy a queued retry must re-send. Always the TEXT variant: a queued retry
   * carries no control, whatever mode the original attempt used.
   */
  retryText: string;
};

export type CommentGuideRequestResult = {
  outcome: GuideAccessActionOutcome;
  /**
   * Set only when the opening SEND itself failed, so the caller can run the same
   * recovery ladder V1 uses. Absent when nothing was sent (closed window, replay,
   * an attempt already past its opening) or when a non-send step failed.
   */
  openingSendFailure?: CommentGuideRequestFailure;
};

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
  /** Sends the snapshotted cover image. Tracked like any other outbound media. */
  sendCover(input: { recipientId: string; mediaUrl: string }): Promise<MetaSendResult>;
  /** Resolves an immutable storage path to a public URL. No network work. */
  coverMediaUrl(path: string): string;
  /** Aggregate-only. Never receives an identifier, token, URL, or copy. */
  recordCoverMetric(
    outcome:
      | "accepted"
      | "failed"
      | "uncertain"
      | "omitted_not_selected"
      | "omitted_mismatch",
  ): Promise<void>;
  /**
   * Whether this attempt's gate may include its cover image. Governs the image only —
   * never follower authorization and never whether the gate itself is sent.
   */
  coverDecision(input: { resourceId: string; triggerId: string }): "include" | "omit";
  /**
   * The three counters below are recorded HERE rather than by the callers, because only
   * this layer knows which kind of check ran. `context.falseResponse` is `"lag"` exactly
   * when the parent has already been asked to follow, which is the definition of a
   * recheck; a caller sees the same outcome value either way and cannot tell them apart.
   * That is why recheck outcomes used to be folded into `fresh_check`.
   *
   * All three are aggregate-only and must never fail a parent action.
   */
  recordFreshCheck(outcome: "follower" | "non_follower" | "unavailable"): Promise<void>;
  recordRecheck(
    outcome: "attempted" | "confirmed" | "not_confirmed" | "unavailable",
  ): Promise<void>;
  recordGateShown(): Promise<void>;
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
    followResult?: GuideFollowResult,
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
          ...(followResult ? { followResult } : {}),
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
    /**
     * The follow answer already in hand, if any. Passed so an uncertain SEND does not get
     * recorded as an uncertain CHECK: only the latter may be re-entered, and conflating
     * them let a parent be sent the same follow gate twice.
     */
    followResult?: GuideFollowResult,
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
        undefined,
        followResult,
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

  /**
   * Expose the snapshotted cover exactly once, ahead of the gate copy.
   *
   * The claim moves `not_shown -> uncertain` BEFORE the send, because at that instant the
   * outcome is genuinely unknown. So a crash, or a second action, finds the exposure
   * already claimed and sends nothing. Only a definite provider acknowledgement settles
   * `accepted`, which is the single signal that lets a later delivery skip the cover.
   *
   * A missing, unreadable or mismatched snapshot degrades to "no cover" rather than
   * withholding the gate: the parent still needs to be told what to do, and the gate copy
   * carries that independently of the image.
   */
  /**
   * The snapshot to hand the durable planner, or nothing.
   *
   * Reads the attempt's own `coverVersionId` and re-checks that the row belongs to the
   * attempt's resource, so a cover can never be paired with another guide's messages even
   * if an owner repointed the keyword mid-attempt. A load failure degrades to no cover
   * rather than withholding the guide.
   */
  async function deliverableCover(
    attempt: GuideAccessAttempt,
  ): Promise<{ versionId: string; resourceId: string; dmStoragePath: string } | null> {
    if (attempt.coverVersionId === null) return null;
    try {
      const snapshot = await dependencies.repository.findCoverSnapshot(attempt.coverVersionId);
      if (!snapshot) return null;
      if (snapshot.resourceId !== attempt.resourceId) {
        dependencies.logger.error(
          { errorCode: "cover_resource_mismatch", attemptId: attempt.id },
          "Guide cover belongs to a different guide",
        );
        return null;
      }
      return snapshot;
    } catch {
      dependencies.logger.error(
        { errorCode: "cover_snapshot_load_failed", attemptId: attempt.id },
        "Guide cover snapshot could not be read",
      );
      return null;
    }
  }

  /** Measurement must never be able to fail a parent-facing operation. */
  async function recordCover(
    outcome:
      | "accepted"
      | "failed"
      | "uncertain"
      | "omitted_not_selected"
      | "omitted_mismatch",
  ): Promise<void> {
    try {
      await dependencies.recordCoverMetric(outcome);
    } catch {
      // Aggregate counters are not worth losing an exposure outcome over.
    }
  }

  async function exposeCoverForGate(
    context: AuthorizationContext,
  ): Promise<"none" | "accepted" | "failed" | "needs_review"> {
    const coverVersionId = context.attempt.coverVersionId;
    if (coverVersionId === null) return "none";

    let snapshot;
    try {
      snapshot = await dependencies.repository.findCoverSnapshot(coverVersionId);
    } catch {
      dependencies.logger.error(
        { errorCode: "cover_snapshot_load_failed", attemptId: context.attempt.id },
        "Guide cover snapshot could not be read",
      );
      return "none";
    }
    if (!snapshot) return "none";
    // Integrity before policy, matching `eligibleCover` on the delivery side: a snapshot
    // paired with a different guide is a fault regardless of whether the rollout would
    // have sent it, and checking the fence first would silence the signal for the whole
    // pre-rollout period.
    if (snapshot.resourceId !== context.attempt.resourceId) {
      dependencies.logger.error(
        { errorCode: "cover_resource_mismatch", attemptId: context.attempt.id },
        "Guide cover belongs to a different guide",
      );
      await recordCover("omitted_mismatch");
      return "none";
    }

    // The rollout fence. This path sends the image DIRECTLY to a non-follower, so without
    // it publishing a cover in the creator console was enough to put an image in front of
    // a real parent while every delivery-side switch was off. Consulted before the claim
    // so a withheld cover stays `not_shown` and remains sendable if the rollout opens.
    if (
      dependencies.coverDecision({
        resourceId: context.attempt.resourceId,
        triggerId: context.attempt.id,
      }) !== "include"
    ) {
      await recordCover("omitted_not_selected");
      return "none";
    }

    // Resolved BEFORE the claim. The claim is one-shot, so a throwing URL resolver would
    // otherwise burn it and settle `failed` for a send that was never attempted.
    let mediaUrl: string;
    try {
      mediaUrl = dependencies.coverMediaUrl(snapshot.dmStoragePath);
    } catch {
      dependencies.logger.error(
        { errorCode: "cover_media_url_failed", attemptId: context.attempt.id },
        "Guide cover URL could not be resolved",
      );
      return "none";
    }

    const claim = await dependencies.repository.claimCoverExposure({
      attemptId: context.attempt.id,
    });
    if (claim.kind !== "claimed") return "none";

    try {
      const receipt = await dependencies.sendCover({
        recipientId: context.senderId,
        mediaUrl,
      });
      // Acknowledged with no message id: the image may or may not have arrived. Counted,
      // because this is precisely the class the runbook tells an operator to watch, and it
      // used to return without recording anything.
      if (!receipt.messageId) {
        await recordCover("uncertain");
        return "needs_review";
      }
      await dependencies.repository.settleCoverExposure({
        attemptId: context.attempt.id,
        exposure: "accepted",
        providerMessageId: receipt.messageId,
      });
      await recordCover("accepted");
      return "accepted";
    } catch (error) {
      if (classifyDirectMessageSend(describeGraphError(error)) === "uncertain") {
        await recordCover("uncertain");
        return "needs_review";
      }
      await dependencies.repository.settleCoverExposure({
        attemptId: context.attempt.id,
        exposure: "failed",
        providerMessageId: null,
      });
      await recordCover("failed");
      return "failed";
    }
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
          "non_follower",
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
            "non_follower",
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

      // The cover belongs to the gate, which is the parent's first impression. The lag
      // response is a nudge and deliberately carries no image.
      if ((await exposeCoverForGate(context)) === "needs_review") {
        const review = await checkpointNeedsReview(
          context.attempt.id,
          "checking_follow",
          "cover_exposure_uncertain",
          checkedAt,
          "non_follower",
        );
        return review.outcome;
      }
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

    // `"non_follower"` is the answer the check actually gave. Without it an uncertain gate
    // send parks the attempt as though we had never found out, which `isRetryableReview`
    // treats as re-checkable — and the parent's next message sends the gate a second time.
    const sendResult = await sendAfterFence(
      context.attempt.id,
      "checking_follow",
      send,
      "non_follower",
    );
    if (sendResult === "needs_review") return "access_attempt_needs_review";
    // Only a provably delivered GATE counts as shown. An uncertain send is excluded because
    // it would inflate the denominator of every downstream gate conversion, and the lag
    // nudge is excluded because it is not the gate — the parent has already seen that.
    if (sendResult === "sent" && context.falseResponse === "gate") {
      try {
        await dependencies.recordGateShown();
      } catch {
        // Aggregate counter only.
      }
    }

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
        "non_follower",
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

    // The one and only producer of `coverAlreadyShown`. It means "do not send this cover
    // again", so it must be true for any exposure that MIGHT have reached the parent:
    //
    //   accepted  — provably arrived.
    //   uncertain — Meta may well have accepted it. The spec forbids ever repeating this
    //               one automatically, and an uncertain gate is re-enterable (the review
    //               keeps `lastFollowResult: "unknown"`), so a later follow-confirm would
    //               otherwise send a second image.
    //   failed    — provably never arrived, so the cover is still owed.
    const cover = await deliverableCover(delivering.attempt);
    const coverAlreadyShown =
      delivering.attempt.coverExposure === "accepted" ||
      delivering.attempt.coverExposure === "uncertain";

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
        ...(cover ? { cover } : {}),
        ...(coverAlreadyShown ? { coverAlreadyShown: true } : {}),
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

  /** Measurement must never fail a parent action. */
  async function countCheck(
    isRecheck: boolean,
    fresh: "follower" | "non_follower" | "unavailable",
    again: "confirmed" | "not_confirmed" | "unavailable",
  ): Promise<void> {
    try {
      if (isRecheck) await dependencies.recordRecheck(again);
      else await dependencies.recordFreshCheck(fresh);
    } catch {
      // An aggregate counter is not worth losing an authorization outcome over.
    }
  }

  async function authorizeClaimed(
    context: AuthorizationContext,
  ): Promise<GuideAccessActionOutcome> {
    let fresh: FreshFollowResult | null = null;
    // `"lag"` means this parent has already been asked to follow, so the check about to
    // run is a RE-check. Recorded as its own stage: "still not following after telling us
    // they had" is a different fact from "was not following when they asked", and the
    // funnel could not separate them while both counted as `fresh_check`.
    const isRecheck = context.falseResponse === "lag";
    if (isRecheck) {
      try {
        await dependencies.recordRecheck("attempted");
      } catch {
        // Denominator only. Never worth failing an authorization for.
      }
    }
    try {
      fresh = await dependencies.resolveFollowStatusFresh(context.senderId);
    } catch {
      // Unexpected verifier failures are indistinguishable from unavailable at
      // this strict boundary. Cached profile data is deliberately not consulted.
    }

    if (fresh?.source === "meta_live" && fresh.isFollower === true) {
      await countCheck(isRecheck, "follower", "confirmed");
      return handleFollower(context, fresh.checkedAt);
    }
    if (fresh?.source === "meta_live" && fresh.isFollower === false) {
      await countCheck(isRecheck, "non_follower", "not_confirmed");
      return handleNonFollower(context, fresh.checkedAt);
    }
    await countCheck(isRecheck, "unavailable", "unavailable");
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
        // A retryable review can descend from `awaiting_follow`: the parent tapped
        // "I'm following", `consumeToken` reset the result to unknown, and the lag
        // send came back uncertain. Treating that retry as first contact would send
        // the initial gate copy AND skip `reserveFollowResponse`, escaping the
        // two-response limit. `followResponseCount` is the durable record that a
        // follow was already asked for.
        falseResponse:
          attempt.state === "awaiting_follow" || attempt.followResponseCount > 0
            ? "lag"
            : "gate",
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

  async function runCommentGuideRequest(
    input: CommentGuideRequest,
    onSendFailure: (failure: CommentGuideRequestFailure) => void,
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
    // Resolved before the send: computing it inside the catch would let a copy
    // validation error replace the provider error and skip the recovery ladder.
    const retryText = guideAccessOpeningText(guideName);
    const disposition = await sendAfterFence(attempt.id, "awaiting_request", async () => {
      let receipt: MetaSendResult;
      try {
        receipt = await dependencies.sendInitialPrivateReply({
          commentId: input.commentId,
          guideName,
          actionToken: issued.token.id,
          capabilities,
        });
      } catch (error) {
        // Report, then rethrow so `sendAfterFence` classifies exactly as before.
        // A definite failure and an uncertain one both need recovery evidence; only
        // the caller's ladder decides what to do with it.
        onSendFailure({ error, retryText });
        throw error;
      }

      // Reported outside the try: Meta can answer 2xx with no `message_id`, which
      // never throws, and that is the one uncertain outcome that would otherwise
      // produce no evidence at all. Kept out of the try so a fault in the report
      // itself can never be re-reported as a provider failure.
      if (!receipt.messageId) {
        onSendFailure({
          error: new Error("guide_opening_missing_provider_message_id"),
          retryText,
        });
      }
      return receipt;
    });
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

  async function startCommentGuideRequest(
    input: CommentGuideRequest,
  ): Promise<CommentGuideRequestResult> {
    let openingSendFailure: CommentGuideRequestFailure | undefined;
    const outcome = await runCommentGuideRequest(input, (failure) => {
      openingSendFailure = failure;
    });
    return openingSendFailure ? { outcome, openingSendFailure } : { outcome };
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
  // The generic (rich) gate template is still text-only until the capability rows say
  // otherwise, so this placeholder is never serialized. The cover now reaches the parent
  // as its own fenced exposure ahead of the gate, not embedded in the gate payload.
  sendFollowerGate: (input) => sendGuideFollowerGate({ ...input, coverUrl: "" }),
  sendText: (input) =>
    sendTrackedText({
      recipientIgUserId: input.recipientId,
      text: input.text,
      source: "keyword_automation",
    }),
  sendFollowLag: sendGuideFollowLag,
  sendInitialPrivateReply: sendGuideInitialPrivateReply,
  sendCover: (input) =>
    sendTrackedMedia({
      recipientIgUserId: input.recipientId,
      type: "image",
      url: input.mediaUrl,
      source: "keyword_automation",
    }),
  coverMediaUrl: publicMediaUrl,
  coverDecision: (decision) => guideCoverDeliverySelector.decide(decision),
  recordCoverMetric: async (outcome) => {
    await recordGuideAccessMetric("cover_gate", outcome);
  },
  recordFreshCheck: async (outcome) => {
    await recordGuideAccessMetric("fresh_check", outcome);
  },
  recordRecheck: async (outcome) => {
    await recordGuideAccessMetric("recheck", outcome);
  },
  recordGateShown: async () => {
    await recordGuideAccessMetric("gate", "shown");
  },
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
