import type { CommentValue } from "../types/meta.js";
import {
  extractCandidates,
  findKeywordForComment,
  scannableCommentMatchCandidates,
} from "../services/keywordService.js";
import { openConversationIn, markGated } from "../services/conversationService.js";
import {
  recordJourneyPublicAcknowledgement,
  resolveJourneyIntent,
} from "../services/journeyIntentService.js";
import { replyToComment } from "../meta/replyToComment.js";
import {
  sendTrackedPrivateCard,
  sendTrackedPrivateReply,
  type TrackedPrivateReplyReceipt,
} from "../services/dmDeliveryService.js";
import {
  GUIDE_GATE_CARD_SUBTITLE,
  guideGateCardSelected,
  loadGateCard,
  sendGuideGateCard,
} from "../services/guideGateCard.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { getFollowState, rememberUsername } from "../services/igUserService.js";
import { selectCommentGate } from "../services/commentGateCopy.js";
import { enqueueGate } from "../services/gateQueueService.js";
import { claimComment } from "../services/commentClaimService.js";
import { env } from "../config/env.js";
import {
  classifyPrivateGateFailure,
  parseGraphSignatures,
} from "../services/graphErrorClassifier.js";
import {
  scheduleAcceptedGateRecovery,
  scheduleSettingsBlockedRecovery,
  scheduleTrackingUnavailableRecovery,
} from "../services/dmRecoveryService.js";
import {
  resolveActiveSettingsBlockedVerification,
  settingsBlockedVerificationRejectionReason,
} from "../services/settingsBlockedVerificationService.js";
import { bindUpcomingAutomationFromComment } from "../services/upcomingAutomationCommentBinding.js";
import { guideFollowGateV2Selector } from "../services/guideFollowGateV2Rollout.js";
import { flags } from "../services/flagService.js";
import { startCommentGuideRequest } from "../services/guideAccessActionService.js";
import { recordGuideAccessMetric } from "../services/guideAccessMetrics.js";
import { guideAudienceAuthorization } from "../services/guideAudienceAuthorization.js";

/**
 * Human-readable scope for a media-attached keyword, from the webhook's
 * media_product_type. Logged on keyword_matched, so historical "reel" values
 * stay comparable: REELS still reads "reel".
 */
// Only a real opening attempt is measured. "Already sent" means this journey
// produced no new outbound message, so counting it would inflate the denominator.
const OPENING_METRIC_OUTCOME = new Map<string, "accepted" | "failed" | "uncertain">([
  ["guide_opening_sent", "accepted"],
  ["guide_opening_failed", "failed"],
  ["access_attempt_needs_review", "uncertain"],
]);

function mediaScopeLabel(productType: string | undefined): string {
  if (productType === "REELS") return "reel";
  if (productType === "FEED") return "carousel";
  return "media";
}

async function persistPublicAcknowledgement(input: {
  commentId: string;
  keywordId: string;
  state: "confirmed" | "failed" | "uncertain";
  replyId: string | null;
  errorCategory: string | null;
}): Promise<void> {
  try {
    await recordJourneyPublicAcknowledgement(input);
  } catch {
    // The provider call has already happened, so never retry it merely because
    // the local audit write failed. Surface a safe reconciliation signal.
    await logEvent("journey_public_acknowledgement_write_failed", {
      commentId: input.commentId,
      keywordId: input.keywordId,
      acknowledgementState: input.state,
    });
  }
}

/**
 * The single recovery ladder for a failed private reply, shared by the V1 gate and
 * the V2 strict opening. Extracted rather than duplicated so the two paths cannot
 * drift on what happens to a parent whose opening never arrived — measured at 15.3%
 * of comment openings over 60 days.
 *
 * `gateMessage` is the exact copy a queued retry will re-send, so each caller passes
 * its own: the V1 gate text, or the strict opening.
 */
async function recoverFailedPrivateReply(input: {
  error: unknown;
  conversationId: string;
  senderId: string;
  keywordId: string;
  keywordSnapshot: string;
  commentId: string;
  parentId: string | null;
  mediaId: string | null;
  gateMessage: string;
}): Promise<void> {
  const metadata = describeGraphError(input.error);
  const classification = classifyPrivateGateFailure(
    metadata,
    parseGraphSignatures(env.DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES),
  );
  await logEvent("dm_failed", {
    conversationId: input.conversationId,
    stage: "gate_private_reply",
    commentId: input.commentId,
    parentId: input.parentId,
    classification,
    ...metadata,
  });
  if (classification === "settings_blocked") {
    let verification;
    try {
      verification = await resolveActiveSettingsBlockedVerification(metadata);
    } catch (verificationError) {
      await logEvent("dm_recovery_verification_rejected", {
        conversationId: input.conversationId,
        commentId: input.commentId,
        triggerKind: "settings_blocked",
        reason: settingsBlockedVerificationRejectionReason(verificationError),
      });
      return;
    }
    try {
      await scheduleSettingsBlockedRecovery({
        conversationId: input.conversationId,
        igUserId: input.senderId,
        keywordId: input.keywordId,
        keywordSnapshot: input.keywordSnapshot,
        commentId: input.commentId,
        mediaId: input.mediaId,
        verification,
      });
    } catch {
      await logEvent("dm_recovery_schedule_failed", {
        conversationId: input.conversationId,
        commentId: input.commentId,
        triggerKind: "settings_blocked",
      });
    }
    return;
  }
  // A permanent rejection or an auth failure cannot succeed on a retry;
  // queueing it only spends one attempt and delays the owner noticing.
  if (classification === "permanent" || classification === "permission_or_auth") {
    return;
  }
  await enqueueGate({
    conversationId: input.conversationId,
    igUserId: input.senderId,
    commentId: input.commentId,
    mediaId: input.mediaId,
    gateMessage: input.gateMessage,
    lastError: metadata.category,
    initialErrorCategory: classification,
  });
  // An ambiguous outcome may already have delivered the gate DM, so the queue
  // row is parked for review rather than retried, and a recovery row is
  // created so the owner can see it.
  if (classification === "uncertain" || classification === "transport_uncertain") {
    try {
      await scheduleTrackingUnavailableRecovery({
        conversationId: input.conversationId,
        igUserId: input.senderId,
        keywordId: input.keywordId,
        keywordSnapshot: input.keywordSnapshot,
        commentId: input.commentId,
        mediaId: input.mediaId,
        observedAt: new Date(),
      });
    } catch {
      await logEvent("dm_recovery_schedule_failed", {
        conversationId: input.conversationId,
        commentId: input.commentId,
        triggerKind: "tracking_unavailable",
      });
    }
  }
}

export async function handleComment(comment: CommentValue): Promise<void> {
  const log = logger.child({ commentId: comment.id });

  if (!comment.text) {
    log.debug("Comment has no text");
    return;
  }

  const senderId = comment.from?.id;
  if (!senderId) {
    log.debug("Comment has no sender id (likely own comment) — skipping");
    return;
  }

  // Comments authored by our own account (the bot's public replies, or manual
  // replies posted from @tinysoho) come back through the webhook like anyone
  // else's. Skip them BEFORE any logging: they must not count as
  // comment_received, and once matching scans every token, a reply such as
  // "DM me sleep" would otherwise trigger a self-reply loop.
  if (senderId === env.IG_USER_ID) {
    log.debug("Comment authored by own account — skipping");
    return;
  }

  // The comment webhook includes the commenter's username for free — store it so
  // the dashboard can show @handle instead of the numeric id. No extra API call.
  await rememberUsername(senderId, comment.from?.username);

  // Record every real user comment we receive. parentId being present means the
  // comment is a reply nested under another comment (a candidate cause of the
  // 2534025 private-reply rejection); a repeated commentId across rows points to
  // duplicate webhook deliveries.
  await logEvent("comment_received", {
    commentId: comment.id,
    parentId: comment.parent_id ?? null,
    fromId: senderId,
    mediaId: comment.media?.id ?? null,
    text: comment.text,
  });

  // All-token matching: scan every word of a short comment (not just the first),
  // so "@tinysoho sleep", "DM EGG", and "Potty🙏" resolve. Long comments fall back
  // to first-word-only for single-key triggers, while exact two-word phrases at
  // the start remain eligible — see scannableCommentMatchCandidates.
  const candidates = extractCandidates(comment.text);
  if (candidates.length === 0) return;
  const upcomingCandidates = scannableCommentMatchCandidates(comment.text);

  // A native-scheduled post has no local keyword until Meta publishes it. If a
  // comment intersects a reserved word, bind from the real caption first so the
  // same first comment can continue through the ordinary post-scoped flow.
  const upcoming = await bindUpcomingAutomationFromComment({
    candidates: upcomingCandidates,
    mediaId: comment.media?.id,
    commentId: comment.id,
  });
  if (upcoming.blockLegacyFallback) {
    await logEvent("comment_ignored", {
      commentId: comment.id,
      candidate: candidates.join(" "),
      mediaId: comment.media?.id ?? null,
      reason: "upcoming_automation_unresolved",
    });
    return;
  }

  const match = await findKeywordForComment(comment.text, comment.media?.id);
  if (!match) {
    log.debug({ candidates, mediaId: comment.media?.id }, "No matching active keyword");
    await logEvent("comment_ignored", {
      commentId: comment.id,
      candidate: candidates.join(" "),
      mediaId: comment.media?.id ?? null,
    });
    return;
  }
  const keyword = match.keyword;

  // A media-scoped keyword can now be attached to a carousel as well as a reel,
  // so derive the label from the webhook's media_product_type ("REELS" | "FEED")
  // rather than assuming reel. Falls back to a generic "media" when Meta omits
  // the field, so the value is never a claim we can't back.
  const scope = keyword.mediaId ? mediaScopeLabel(comment.media?.media_product_type) : "global";

  log.info(
    { keyword: keyword.keyword, scope, matchMode: match.mode, mediaId: comment.media?.id },
    "Keyword matched",
  );

  // Claim the comment before anything outward-facing happens. Meta delivers
  // webhooks at least once, and everything below — the conversation, the public
  // reply, the gate DM — would otherwise run a second time for one comment.
  // Claimed after keyword matching so a non-matching comment consumes nothing.
  if (!(await claimComment(comment.id, senderId))) {
    log.debug("Comment already handled — skipping duplicate delivery");
    return;
  }

  // A blocked guide decision must stop BEFORE the public acknowledgement: the
  // user explicitly does not want a comment, private gate, recovery, or guide.
  // The authorization service writes the safe internal audit record.
  //
  // Failure sends. A gate that cannot reach a verdict silenced 46 of 60 people
  // wrongly during the NVIDIA incident, 21 of them confirmed US audience, so a
  // broken boundary now costs an occasional out-of-market reply instead of
  // dropping in-market ones. The service itself audits this as allow_unverified.
  try {
    const audienceDecision = await guideAudienceAuthorization.authorizeNewGuideAction({
      igUserId: senderId,
      source: "comment",
      commentId: comment.id,
      resourceId: keyword.resourceId,
    });
    if (audienceDecision.kind === "block") return;
  } catch {
    log.error(
      { errorCode: "guide_audience_authorization_failed", igUserId: senderId },
      "Guide audience authorization failed — sending anyway",
    );
  }

  // Attach this comment to the person's canonical journey for this keyword. Two
  // comments for the same guide are two different Meta comment ids, so the claim
  // above cannot merge them — that guard only stops the SAME comment being
  // delivered twice. Without this, asking twice meant two journeys and two gate
  // DMs, which happened 342 times in production history.
  const journey = await resolveJourneyIntent(
    {
      igUserId: senderId,
      keywordId: keyword.id,
      commentId: comment.id,
      mediaId: comment.media?.id ?? null,
      // The comment webhook carries no timestamp, so arrival time is the best
      // available. `enqueueGate` already defaults `commentAt` the same way.
      receivedAt: new Date(),
      triggerKind: "comment",
    },
    (tx) => openConversationIn(tx, senderId, keyword.id),
  );

  const convo = { id: journey.conversationId! };
  log.info(
    { conversationId: convo.id, disposition: journey.disposition },
    journey.disposition === "new_journey" ? "Conversation opened" : "Attached to existing journey",
  );

  await logEvent("keyword_matched", {
    conversationId: convo.id,
    commentId: comment.id,
    // Which journey this comment joined, and whether it opened one. A rising
    // reused_active share is the measure of how much duplicate sending this
    // prevents.
    journeyDisposition: journey.disposition,
    parentId: comment.parent_id ?? null,
    keyword: keyword.keyword,
    // Observability for the all-token rollout: matchedToken names the word that
    // fired; tokenCount > 1 flags a comment the old first-word matcher would have
    // missed, so a post-deploy audit can spot-check for false positives.
    matchedToken: match.matchedToken,
    tokenCount: candidates.length,
    scope,
    // How the keyword resolved. "post_strict" means the post had its own keywords
    // and only those were considered; "global_fallback" means the post has none
    // attached yet and a legacy global answered. Lets a post-deploy audit watch
    // adoption move from fallback to strict without guessing.
    matchMode: match.mode,
    mediaId: comment.media?.id ?? null,
  });

  try {
    const acknowledgement = await replyToComment(comment.id, keyword.publicReply);
    await persistPublicAcknowledgement({
      commentId: comment.id,
      keywordId: keyword.id,
      state: "confirmed",
      replyId: acknowledgement?.replyId ?? null,
      errorCategory: null,
    });
    await logEvent("public_reply_sent", { conversationId: convo.id, commentId: comment.id });
  } catch (err) {
    const metadata = describeGraphError(err);
    const definitelyNotDelivered =
      metadata.category === "graph_response" ||
      (metadata.category === "graph_transport" &&
        ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(metadata.transportCode ?? ""));
    await persistPublicAcknowledgement({
      commentId: comment.id,
      keywordId: keyword.id,
      state: definitelyNotDelivered ? "failed" : "uncertain",
      replyId: null,
      errorCategory: metadata.category,
    });
    log.warn(metadata, "Public reply failed (non-fatal)");
    await logEvent("public_reply_failed", {
      conversationId: convo.id,
      commentId: comment.id,
      ...metadata,
    });
  }

  // The public acknowledgement is per-COMMENT: someone who asks twice gets a
  // reply on each comment, because a comment left visibly unanswered reads as
  // being ignored. The gate DM is per-JOURNEY, so it stops here.
  //
  // Nothing below runs for a reused journey: no second DM, no second queue row,
  // and no second recovery reminder. The first journey already owns all three,
  // and its gate is either delivered or being retried.
  if (!journey.maySendGate) {
    log.info(
      { conversationId: convo.id, disposition: journey.disposition },
      "Gate DM withheld — this journey already has one",
    );
    await logEvent("gate_withheld_duplicate_journey", {
      conversationId: convo.id,
      commentId: comment.id,
      disposition: journey.disposition,
    });
    return;
  }

  // ---- Strict follower gate V2 ---------------------------------------------
  // Ownership is decided exactly once, from the sender and the guide only, and
  // fails closed to V1 so a flag-read problem can never strand a parent. Placed
  // after the claim, the journey merge, and the one-gate-per-journey guard, so
  // the strict path inherits all three rather than reimplementing them.
  let strictGateOwner: "v1" | "v2" = "v1";
  try {
    strictGateOwner = guideFollowGateV2Selector.owner({
      igUserId: senderId,
      resourceId: keyword.resourceId,
    });
  } catch {
    log.warn({ igUserId: senderId }, "Strict gate ownership unavailable — using V1");
  }

  if (strictGateOwner === "v2") {
    try {
      const result = await startCommentGuideRequest({
        conversationId: convo.id,
        igUserId: senderId,
        resourceId: keyword.resourceId,
        commentId: comment.id,
        // The comment webhook carries no timestamp, so arrival time is the best
        // available — the same basis `enqueueGate` uses for `commentAt`.
        observedAt: new Date(),
      });
      if (flags.bool("DM_RECOVERY_TWO_HOUR_ALL_ENABLED") && result.openingReceipt) {
        const receipt = result.openingReceipt;
        try {
          await scheduleAcceptedGateRecovery({
            conversationId: convo.id,
            igUserId: senderId,
            keywordId: keyword.id,
            keywordSnapshot: keyword.keyword,
            commentId: comment.id,
            mediaId: comment.media?.id ?? null,
            gateDmMessageId: receipt.dmMessageId,
            instagramGateMessageId: receipt.instagramMessageId,
            acceptedAt: receipt.acceptedAt,
          });
        } catch {
          await logEvent("dm_recovery_schedule_failed", {
            conversationId: convo.id,
            commentId: comment.id,
            triggerKind: "no_confirmed_read",
          });
        }
      }
      const measured = OPENING_METRIC_OUTCOME.get(result.outcome);
      if (measured) {
        await recordGuideAccessMetric("opening", measured);
      }
      // Same ladder V1 runs, so a parent whose opening never arrived is queued,
      // recovered, or escalated rather than dropped. Only the retry copy differs.
      if (result.openingSendFailure) {
        await recoverFailedPrivateReply({
          error: result.openingSendFailure.error,
          conversationId: convo.id,
          senderId,
          keywordId: keyword.id,
          keywordSnapshot: keyword.keyword,
          commentId: comment.id,
          parentId: comment.parent_id ?? null,
          mediaId: comment.media?.id ?? null,
          gateMessage: result.openingSendFailure.retryText,
        });
      }
    } catch (error) {
      // A strict-path fault must not fail the webhook or fall through to V1:
      // falling through would send a second message for one comment.
      log.error(describeGraphError(error), "Strict guide opening failed");
    }
    return;
  }

  let gate = selectCommentGate({
    isFollower: null,
    defaultMessage: keyword.gateMessage,
  });
  try {
    const followState = await getFollowState(senderId);
    gate = selectCommentGate({
      isFollower: followState.isFollower,
      defaultMessage: keyword.gateMessage,
    });
  } catch {
    log.warn(
      { igUserId: senderId, followerState: "unavailable" },
      "Cached follower state unavailable; using default gate",
    );
  }

  // The card, when this commenter is in the share and this guide has a square cover.
  //
  // Resolved BEFORE the send and treated as all-or-nothing: Meta allows one private reply per
  // comment, so there is no sending a card and then a text, or the reverse. Either decision
  // consumes the single reply. Anything unknown here — flags unreadable, no square published,
  // lookup failed — resolves to the text gate, which is the message that has been converting
  // all along.
  let card: { coverUrl: string } | null = null;
  if (guideGateCardSelected({ igUserId: senderId, resourceId: keyword.resourceId })) {
    card = await loadGateCard(keyword.resourceId);
  }

  let receipt: TrackedPrivateReplyReceipt;
  try {
    receipt = card
      ? await sendTrackedPrivateCard({
          recipientIgUserId: senderId,
          commentId: comment.id,
          coverUrl: card.coverUrl,
          subtitle: GUIDE_GATE_CARD_SUBTITLE,
          source: "keyword_automation",
          send: () =>
            sendGuideGateCard({
              commentId: comment.id,
              coverUrl: card.coverUrl,
            }),
        })
      : await sendTrackedPrivateReply({
          recipientIgUserId: senderId,
          commentId: comment.id,
          text: gate.text,
          source: "keyword_automation",
        });
  } catch (error) {
    // No text retry after a failed card. The failure may be one of Meta's 500-but-delivered
    // responses — observed twice on 2026-08-24 — and a "fallback" text would then be a second
    // message on a surface that allows one. The existing ladder already handles this: an
    // uncertain outcome parks for owner review rather than retrying.
    await recoverFailedPrivateReply({
      error,
      conversationId: convo.id,
      senderId,
      keywordId: keyword.id,
      keywordSnapshot: keyword.keyword,
      commentId: comment.id,
      parentId: comment.parent_id ?? null,
      mediaId: comment.media?.id ?? null,
      gateMessage: gate.text,
    });
    return;
  }

  await logEvent("dm_sent", { conversationId: convo.id, kind: "gate", gateVariant: gate.variant });

  const [gateStateResult, recoveryResult] = await Promise.allSettled([
    markGated(convo.id),
    scheduleAcceptedGateRecovery({
      conversationId: convo.id,
      igUserId: senderId,
      keywordId: keyword.id,
      keywordSnapshot: keyword.keyword,
      commentId: comment.id,
      mediaId: comment.media?.id ?? null,
      gateDmMessageId: receipt.dmMessageId,
      instagramGateMessageId: receipt.instagramMessageId,
      acceptedAt: receipt.acceptedAt,
    }),
  ]);
  if (gateStateResult.status === "rejected") {
    await logEvent("gate_state_reconciliation_failed", {
      conversationId: convo.id,
      commentId: comment.id,
    });
  }
  if (recoveryResult.status === "rejected") {
    await logEvent("dm_recovery_schedule_failed", {
      conversationId: convo.id,
      commentId: comment.id,
      triggerKind: "no_confirmed_read",
    });
  }
}
