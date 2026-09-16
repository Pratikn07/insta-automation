import type { DmMessageType, ResourceMessage } from "@prisma/client";
import type { MessagingEntry } from "../types/meta.js";
import { flags } from "../services/flagService.js";
import {
  findActiveAwaitingDone,
  findLatestIncompleteConversation,
  hasCompletedKeyword,
  markCompleted,
  markGated,
  openConversationIn,
} from "../services/conversationService.js";
import { findDmKeywordCandidates, textContainsKeyword } from "../services/keywordService.js";
import {
  classifyDmKeywordIntent,
  classifyOpenRequestReply,
  type DmKeywordIntent,
  type OpenRequestReplyIntent,
} from "../services/dmGuideIntent.js";
import { resolveJourneyIntent } from "../services/journeyIntentService.js";
import { sendSequence } from "../services/sequenceSender.js";
import {
  sendCoverBeforeGate,
  wasCoverShownAtGate,
  withoutAlreadyShownCover,
} from "../services/guideCoverGateExposure.js";
import { guideDeliveryOwner } from "../services/guideDeliveryRollout.js";
import { deliverGuideForTrigger } from "../services/guideDeliveryService.js";
import { sendTrackedText } from "../services/dmDeliveryService.js";
import {
  markInboundDeleted,
  markThreadResolved,
  recordInboundMessage,
  updateDmThreadProfile,
} from "../services/dmThreadService.js";
import { recordRecoveryInbound } from "../services/dmRecoveryService.js";
import { queueReplyDraft } from "../services/replyDraftService.js";
import { scheduleEngagementFollowUp } from "../services/engagementFollowUpService.js";
import { logger } from "../lib/logger.js";
import { parseProviderTimestamp } from "../lib/providerTime.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { resolveUsername } from "../services/igUserService.js";
import { attributeRecoveryOutcomeSafely } from "../services/historicalRecoveryAttribution.js";
import {
  markInboundCampaignHealthCaptured,
  recordInboundCampaignHealthSignals,
} from "../services/campaignHealthObservation.js";
import { env, guideDeliveryCohortIgUserIds, parseIdentifierSet } from "../config/env.js";
import { routeGuideAction } from "./guideActionRouter.js";
import { guideFollowGateV2Selector } from "../services/guideFollowGateV2Rollout.js";
import { startDirectDmGuideRequest } from "../services/guideAccessActionService.js";
import { recordGuideAccessMetric } from "../services/guideAccessMetrics.js";

/**
 * The only outcomes this branch still measures itself.
 *
 * Everything else moved into `guideAccessActionService`, because this map could only ever
 * see the direct-DM branch: a parent who taps a control reaches the same outcomes through
 * `routeGuideAction`, which never consulted this and so recorded nothing at all. The
 * follow checks, the review marking and the delivery start are all recorded at the point
 * they happen now, which covers every entry path instead of one.
 *
 * A token replay or expiry, though, is genuinely about THIS inbound message rather than
 * about the attempt, so it stays here.
 */
async function recordDirectStrictOutcome(outcome: string): Promise<void> {
  if (outcome === "action_replayed") await recordGuideAccessMetric("action", "replayed");
  if (outcome === "action_expired") await recordGuideAccessMetric("action", "expired");
}

/**
 * One ownership decision per call site, failing closed to V1 so a flag-read
 * problem can never strand a parent between the two paths.
 */
function strictGateOwnerFor(igUserId: string, resourceId: string): "v1" | "v2" {
  try {
    return guideFollowGateV2Selector.owner({ igUserId, resourceId });
  } catch {
    logger.warn(
      { errorCode: "strict_gate_owner_unavailable", igUserId },
      "Strict gate ownership unavailable — using V1",
    );
    return "v1";
  }
}

/**
 * The single V2 entry point for an inbound DM. Shared by the keyword branch and
 * the reply-to-opening branch so the two can never diverge on what authorizes a
 * send. A fault here never falls through to V1: doing so would send a second
 * message for one inbound, and would authorize it on cached evidence.
 */
async function runStrictGuideRequest(input: {
  conversationId: string;
  senderId: string;
  resourceId: string;
  guideName: string;
  redelivery: boolean;
  inboundMessageId: string;
  threadId: string | null;
  observedAt: Date;
}): Promise<void> {
  try {
    const outcome = await startDirectDmGuideRequest(
      {
        id: input.conversationId,
        igUserId: input.senderId,
        resourceId: input.resourceId,
        guideName: input.guideName,
        deliveryTriggerKind: input.redelivery ? "explicit_redelivery" : "inbound_reply",
        ...(input.redelivery ? { redeliveryIntro: REDELIVERY_INTRO } : {}),
      },
      {
        // The internal DmMessage UUID, never Meta's provider mid.
        id: input.inboundMessageId,
        threadId: input.threadId,
        eventAt: input.observedAt,
      },
    );
    await recordDirectStrictOutcome(outcome);
  } catch (err) {
    logger.error(
      { ...graphFailureMetadata(err), conversationId: input.conversationId },
      "Strict guide request failed",
    );
  }
}

// Exact DONE retains the existing recovery path after the internal gate expires.
const DONE_RE = /^\s*done\s*[!.]*\s*$/i;

// Follow-aware closing line, sent AFTER the guide. Hybrid policy: everyone still
// gets the guide; we only personalize the nudge. Non-follower / unknown defaults to
// the follow ask (safe: IG's follow flag can lag a real tap by minutes, so we never
// withhold — we only encourage).
const FOLLOWER_THANKS = "Thanks for following! 💛";
const FOLLOW_NUDGE = "Follow @tinysoho so you don't miss the next one 🙏";
// Sent before redelivering a guide the user already received — replaces the old
// silent skip, which left our most engaged users with no response at all.
const REDELIVERY_INTRO = "You've already got this one — here it is again 💛";
// Hard follow gate: shown when a confirmed non-follower replies to the gate. The
// parenthetical pre-empts the follow-flag lag (a real tap can take minutes to
// register), so someone who just followed knows to simply reply again.
const FOLLOW_GATE =
  "You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over. (Just followed? Give it a few seconds and reply DONE again.)";
const STANDARD_DM_WINDOW_MS = 24 * 60 * 60 * 1000;

function graphFailureMetadata(err: unknown): Record<string, unknown> {
  return { errorCode: "graph_request_failed", ...describeGraphError(err) };
}

async function scheduleFollowUpAfterDelivery(input: {
  conversationId: string;
  threadId: string;
  inboundMessageId: string;
  inboundAt: Date;
  deliveredAt: Date | null;
}): Promise<void> {
  if (!flags.bool("AI_FOLLOW_UPS_ENABLED")) return;

  if (!input.deliveredAt) {
    logger.error(
      {
        errorCode: "follow_up_completion_timestamp_missing",
        conversationId: input.conversationId,
        threadId: input.threadId,
        inboundMessageId: input.inboundMessageId,
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
    return;
  }

  try {
    await scheduleEngagementFollowUp({ ...input, deliveredAt: input.deliveredAt });
  } catch {
    // The guide is already delivered and completion is recorded. Follow-up
    // queueing is best-effort and must never make that successful path look
    // failed (or leak a database/backend error that could contain private text).
    logger.error(
      {
        errorCode: "follow_up_schedule_failed",
        conversationId: input.conversationId,
        threadId: input.threadId,
        inboundMessageId: input.inboundMessageId,
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
  }
}

async function sendFollowAwareClosing(input: {
  conversationId: string;
  senderId: string;
  isFollower: boolean | null;
}): Promise<void> {
  try {
    const closing = input.isFollower ? FOLLOWER_THANKS : FOLLOW_NUDGE;
    await sendTrackedText({
      recipientIgUserId: input.senderId,
      text: closing,
      source: "guide_automation",
    });
    await logEvent("follow_nudge_sent", {
      conversationId: input.conversationId,
      isFollower: input.isFollower,
      variant: input.isFollower ? "thanks" : "nudge",
    });
  } catch (err) {
    logger.warn(
      { ...graphFailureMetadata(err), conversationId: input.conversationId },
      "Follow-aware closing message failed (guide already delivered)",
    );
  }
}

async function deliverOwnedGuide(input: {
  conversationId: string;
  resourceId: string;
  messages: ResourceMessage[];
  senderId: string;
  threadId: string;
  triggerId: string;
  triggeredAt: Date;
  followerAtTrigger: boolean | null;
  triggerKind: "inbound_reply" | "explicit_redelivery";
  redeliveryIntro?: string;
  legacyEventContext: Readonly<Record<string, string | boolean>>;
  sendClosingNudge: boolean;
}): Promise<void> {
  const owner = guideDeliveryOwner({
    enabled: flags.bool("GUIDE_DELIVERY_ENABLED"),
    rolloutPercent: flags.percent("GUIDE_DELIVERY_ROLLOUT_PERCENT"),
    cohortIgUserIds: guideDeliveryCohortIgUserIds(
      env.GUIDE_DELIVERY_COHORT_IG_USER_IDS,
    ),
    igUserId: input.senderId,
    triggerId: input.triggerId,
  });

  switch (owner) {
    case "ledger": {
      const result = await deliverGuideForTrigger({
        conversationId: input.conversationId,
        resourceId: input.resourceId,
        igUserId: input.senderId,
        threadId: input.threadId,
        triggerKind: input.triggerKind,
        triggerId: input.triggerId,
        triggeredAt: input.triggeredAt,
        sendWindowExpiresAt: new Date(
          input.triggeredAt.getTime() + STANDARD_DM_WINDOW_MS,
        ),
        followerAtTrigger: input.followerAtTrigger,
        ...(input.redeliveryIntro ? { redeliveryIntro: input.redeliveryIntro } : {}),
      });
      if (result === "completed" && input.sendClosingNudge) {
        await sendFollowAwareClosing({
          conversationId: input.conversationId,
          senderId: input.senderId,
          isFollower: input.followerAtTrigger,
        });
      }
      return;
    }
    case "legacy": {
      if (input.redeliveryIntro) {
        await sendTrackedText({
          recipientIgUserId: input.senderId,
          text: input.redeliveryIntro,
          source: "keyword_automation",
        });
      }
      await sendSequence({
        igUserId: input.senderId,
        messages: input.messages,
        source: "guide_automation",
      });
      const completed = await markCompleted(input.conversationId);
      await scheduleFollowUpAfterDelivery({
        conversationId: input.conversationId,
        threadId: input.threadId,
        inboundMessageId: input.triggerId,
        inboundAt: input.triggeredAt,
        deliveredAt: completed.completedAt,
      });
      await markThreadResolved({
        threadId: input.threadId,
        inboundMessageId: input.triggerId,
      });
      await logEvent("sequence_completed", {
        conversationId: input.conversationId,
        followerAtDelivery: input.followerAtTrigger,
        ...input.legacyEventContext,
      });
      if (input.sendClosingNudge) {
        await sendFollowAwareClosing({
          conversationId: input.conversationId,
          senderId: input.senderId,
          isFollower: input.followerAtTrigger,
        });
      }
      return;
    }
  }
}

/**
 * Did they tag us in THEIR story?
 *
 * This is engagement, not a message: they never opened the thread and never
 * typed anything. Meta still delivers it down the messages webhook, with no text
 * and no attachments, which is precisely why it has to be recognized explicitly.
 *
 * A reply to OUR story (`story.reply_to`) is the opposite — their own words, a
 * real message — and is deliberately NOT matched here.
 */
function isStoryMention(msg: NonNullable<MessagingEntry["message"]>): boolean {
  return msg.story?.mention !== undefined;
}

/**
 * Classify an inbound message for the DmMessage row.
 *
 * Meta omits `text` entirely for media, so without this an image-only DM would be
 * recorded as an empty text message and read as if the user sent nothing.
 */
function classifyInbound(msg: NonNullable<MessagingEntry["message"]>): {
  messageType: DmMessageType;
  mediaUrl: string | null;
} {
  // A story mention carries no text and no attachments, so it must be caught
  // before the attachment check or it lands in the `text` bucket and reads as
  // the person having typed nothing at us.
  if (isStoryMention(msg)) {
    return { messageType: "unknown", mediaUrl: msg.story?.mention?.link ?? null };
  }

  const attachment = msg.attachments?.[0];
  if (!attachment) return { messageType: "text", mediaUrl: null };

  const url = attachment.payload?.url ?? null;
  switch (attachment.type) {
    case "image":
    case "video":
    case "audio":
    case "file":
      return { messageType: attachment.type, mediaUrl: url };
    default:
      // A share, story mention, reaction or anything Meta adds later. Recorded as
      // `unknown` with its URL rather than guessed into the wrong bucket.
      return { messageType: "unknown", mediaUrl: url };
  }
}

export async function handleMessage(entry: MessagingEntry): Promise<void> {
  const msg = entry.message;
  if (!msg || msg.is_echo) return;

  // Webhook JSON is untrusted. Everything below keys on the mid — thread
  // capture, deletion, and evidence correlation — so a missing one must be
  // acknowledged and dropped rather than reaching persistence.
  if (typeof msg.mid !== "string" || msg.mid.trim() === "") {
    logger.warn(
      { errorCode: "inbound_message_missing_mid", senderId: entry.sender?.id ?? null },
      "Inbound message webhook has no usable mid — acknowledged without capture",
    );
    return;
  }

  const senderId = entry.sender.id;
  if (senderId === env.IG_USER_ID) return;

  if (msg.is_deleted) {
    await markInboundDeleted(msg.mid, parseProviderTimestamp(entry.timestamp));
    return;
  }

  const text = msg.text ?? "";
  const observedAt = parseProviderTimestamp(entry.timestamp);

  // Capture the real message into its thread. Idempotent on Meta's `mid`: Meta
  // retries webhooks, and a replay must not re-run automation, re-send a guide, or
  // re-open a thread the owner already answered.
  const { messageType, mediaUrl } = classifyInbound(msg);
  await logEvent("message_received", {
    senderId,
    mid: msg.mid,
    messageType,
    textLength: text.length,
  });
  const inbound = await recordInboundMessage({
    igAccountId: env.IG_USER_ID,
    igUserId: senderId,
    instagramMessageId: msg.mid,
    text: text || null,
    messageType,
    mediaUrl,
    // Meta's timestamp, not ours, so a delayed webhook still orders correctly.
    instagramTimestamp: observedAt,
  });
  try {
    await recordInboundCampaignHealthSignals({
      igUserId: senderId,
      instagramMessageId: msg.mid,
      text,
      observedAt,
    });
    await markInboundCampaignHealthCaptured(inbound.messageId, new Date());
  } catch {
    // The server acknowledges Meta before dispatching handlers, so throwing cannot ask
    // for a replay. The inbound row remains a durable pending safety-inbox item instead;
    // the historical worker must reconcile it successfully before opening any batch.
    logger.error(
      { errorCode: "campaign_health_inbound_capture_failed", senderId, mid: msg.mid },
      "Could not record historical campaign health evidence",
    );
  }

  if (inbound.duplicate) {
    logger.debug(
      { senderId, mid: msg.mid, duplicate: true },
      "Inbound webhook ignored (duplicate)",
    );
    return;
  }

  // Record recovery inbound evidence for any newly captured inbound message (even if delayed)
  const recoveryKind = msg.quick_reply
    ? "quick_reply"
    : msg.attachments?.length
      ? "attachment"
      : "inbound_reply";
  await recordRecoveryInbound({
    igUserId: senderId,
    eventAt: observedAt,
    receivedAt: new Date(),
    kind: recoveryKind,
  });

  // The same evidence, for the historical campaigns (QA-12). `laterInboundAt` had no
  // writer, so "they came back after we reminded them" was unmeasurable.
  //
  // No keyword: an inbound DM does not name one — 608 of 683 measured over 60 days are a
  // bare "DONE" — so this is person-level evidence. The keyword-exact outcome is
  // recorded on completion instead.
  //
  // Non-throwing: measurement must never break message handling.
  await attributeRecoveryOutcomeSafely({
    igUserId: senderId,
    at: observedAt,
    kind: "inbound",
  });

  // A quick-reply token is durable action intent even when a later ordinary DM
  // reached the thread first. Route it after capture/evidence but before the
  // latest-message guard; the action service owns sender, expiry, state, and
  // replay validation. Its visible title must never enter free-text automation.
  if (msg.quick_reply) {
    const routed = await routeGuideAction({
      payload: msg.quick_reply.payload,
      senderId,
      eventId: inbound.messageId,
      source: "quick_reply",
      inboundMessageId: inbound.messageId,
      eventAt: observedAt,
    });
    // Returning either way is deliberate: falling through would let the reply's visible
    // title reach keyword matching as if the parent had typed it. But a payload this router
    // does not recognise was being dropped in total silence, which would make any future
    // quick reply added elsewhere in the product vanish here with no trace. Say so.
    if (routed.kind === "ignored") {
      logger.warn(
        { errorCode: "quick_reply_payload_unrouted", senderId, mid: msg.mid },
        "Quick reply payload matched no guide action and was not routed anywhere else",
      );
    }
    return;
  }

  if (!inbound.becameLatest) {
    logger.debug(
      { senderId, mid: msg.mid, duplicate: false, becameLatest: false },
      "Inbound webhook ignored for conversation routing (not latest)",
    );
    return;
  }

  // DM webhooks don't carry a username — resolve it via the Graph API (non-throwing
  // so it can't break message handling). The same call also returns follow intel
  // (is_user_follow_business), which we use to personalize the guide delivery below.
  const profile = await resolveUsername(senderId).catch((err: unknown) => {
    logger.warn(
      { errorCode: "profile_resolve_failed", senderId },
      "Profile resolve failed — continuing without it",
    );
    return { isFollower: null, username: null, name: null };
  });
  await updateDmThreadProfile({
    threadId: inbound.threadId,
    username: profile.username ?? null,
    name: profile.name ?? null,
  });

  // ---- 0. Story mention → record it and stop -------------------------------
  // Someone tagging us in their story is not them talking to us, so none of the
  // branches below may treat it as intent. Two things went wrong in production
  // on 2026-08-08 because it reached them:
  //
  //   - it satisfied the "any reply unlocks the gate" rule below and delivered a
  //     guide the person had never replied to ask for;
  //   - when there was no open gate it reached the drafting branch, which
  //     answered "your message came through blank" — it wasn't blank.
  //
  // The thread keeps the mention and stays flagged for the owner, who can reply
  // if they want to. That is the only correct actor here: a human.
  if (isStoryMention(msg)) {
    logger.info({ senderId, mid: msg.mid }, "Story mention — recorded, no automation");
    await logEvent("story_mention_received", { senderId, mid: msg.mid });
    return;
  }

  // Resolve all matching rows in token order. A lookup failure deliberately
  // propagates: it must never turn into permission to advance an older request.
  const lookup = await findDmKeywordCandidates(text);
  const firstMatch = lookup.matches[0];
  const matchedKeyword = firstMatch
    ? { ...firstMatch.keyword, inferredFromPost: firstMatch.inferredFromPost }
    : null;
  const enforced =
    flags.bool("GUIDE_DM_INTENT_GUARD_ENABLED") ||
    parseIdentifierSet(env.GUIDE_DM_INTENT_GUARD_IG_USER_IDS).has(senderId);

  // Keep the old repeat-only safeguard while enforcement is off. This makes
  // shadow mode a measurement, not an unannounced behaviour change.
  const alreadyCompleted = matchedKeyword
    ? await hasCompletedKeyword(senderId, matchedKeyword.id)
    : false;
  const suppressedRedelivery =
    matchedKeyword !== null &&
    alreadyCompleted &&
    !textContainsKeyword(text, matchedKeyword.keyword);
  const legacyKeyword = suppressedRedelivery ? null : matchedKeyword;

  if (!enforced && suppressedRedelivery) {
    logger.info(
      { senderId, mid: msg.mid, keyword: matchedKeyword.keyword },
      "Keyword inside a longer DM for a guide they already have — not redelivering",
    );
    await logEvent("keyword_redelivery_suppressed", {
      senderId,
      mid: msg.mid,
      keyword: matchedKeyword.keyword,
      textLength: text.length,
    });
  }

  // Loading the open request is read-only. It supplies both routing and truthful
  // shadow telemetry; a clear new keyword still takes priority over this request.
  let convo = await findActiveAwaitingDone(senderId);
  let recoveredInactiveGate = false;
  if (!convo && DONE_RE.test(text)) {
    convo = await findLatestIncompleteConversation(senderId);
    recoveredInactiveGate = convo !== null;
  }

  type ResolvedKeywordRow = (typeof lookup.matches)[number]["keyword"];
  let keywordIntent: DmKeywordIntent<ResolvedKeywordRow> | null = null;
  let replyIntent: OpenRequestReplyIntent | null = null;
  let classifierFailed = false;
  try {
    keywordIntent = classifyDmKeywordIntent(lookup.meaningfulTokens, lookup.matches);
    replyIntent = classifyOpenRequestReply(text, messageType);
  } catch {
    classifierFailed = true;
    logger.error(
      { errorCode: "dm_guide_intent_classifier_failed", enforced },
      "DM guide intent classification failed",
    );
  }

  const acceptedKeyword =
    !classifierFailed && keywordIntent && "selected" in keywordIntent && messageType === "text"
      ? {
          ...keywordIntent.selected.keyword,
          inferredFromPost: keywordIntent.selected.inferredFromPost,
        }
      : null;
  const acceptedReply = !classifierFailed && replyIntent?.kind === "accepted_confirmation";
  const guardedAction = classifierFailed
    ? "owner_review"
    : acceptedKeyword
      ? "start_keyword"
      : convo && acceptedReply
        ? "advance_open_request"
        : "owner_review";

  // Only aggregate-safe decisions/counts and the existing internal inbound
  // association leave this boundary. Never log text, username or keyword values.
  try {
    await logEvent("dm_guide_intent_evaluated", {
      inboundMessageId: inbound.messageId,
      enforced,
      keywordClassification: keywordIntent?.kind ?? "classifier_failed",
      replyClassification: convo ? replyIntent?.kind ?? "classifier_failed" : "not_applicable",
      replyRejectionReason:
        convo && replyIntent?.kind === "rejected_reply" ? replyIntent.reason : null,
      meaningfulTokenCount: lookup.meaningfulTokens.length,
      keywordHitCount: keywordIntent?.keywordHitCount ?? lookup.matches.length,
      distinctGuideCount: keywordIntent?.distinctGuideCount ?? null,
      selectedKeywordPosition:
        keywordIntent && "selected" in keywordIntent ? keywordIntent.selected.tokenPosition : null,
      hadOpenRequest: convo !== null,
      legacyAction: legacyKeyword
        ? "would_start_keyword"
        : convo
          ? "would_advance_open_request"
          : "would_not_automate",
      guardedAction,
    });
  } catch {
    logger.warn(
      { errorCode: "dm_guide_intent_metric_failed" },
      "DM guide intent metric could not be recorded",
    );
  }

  // ---- 1. Clear new keyword → existing journey and strict delivery path ----
  const keyword = enforced ? acceptedKeyword : legacyKeyword;
  if (keyword) {
    // Attach the ask to this person's canonical journey for this keyword, so the
    // dashboard counts one request rather than one per ask. Measured: 257 of the
    // 342 same-person-same-keyword repeats inside 48 hours arrive by DM, more than
    // the comment path.
    //
    // `maySendGate` is deliberately IGNORED here. 188 of those 257 DM repeats had
    // already completed — they are people re-asking for a guide they own, and this
    // path answers that on purpose with REDELIVERY_INTRO below. Suppressing them
    // would break a working feature. Only the comment path withholds a send; here
    // resolution is bookkeeping.
    const journey = await resolveJourneyIntent(
      {
        igUserId: senderId,
        keywordId: keyword.id,
        // A DM has no comment, so the inbound message id stands in. It is unique
        // per message, which buys the same replay protection the comment path
        // gets from its comment id.
        commentId: inbound.messageId,
        mediaId: keyword.mediaId ?? null,
        receivedAt: parseProviderTimestamp(entry.timestamp) ?? new Date(),
        triggerKind: "dm",
      },
      (tx) => openConversationIn(tx, senderId, keyword.id),
    );
    const keywordConversation = { id: journey.conversationId! };

    logger.info(
      {
        conversationId: keywordConversation.id,
        keyword: keyword.keyword,
        senderId,
        disposition: journey.disposition,
        inferredFromPost: keyword.inferredFromPost,
      },
      "Keyword matched in DM",
    );
    await logEvent("keyword_matched", {
      conversationId: keywordConversation.id,
      keyword: keyword.keyword,
      source: "dm",
      senderId,
      journeyDisposition: journey.disposition,
      // A DM carries no post, so when only post-scoped rows hold the word we pick
      // the newest post and record which one here. Null means an unambiguous
      // global answered — no inference was needed.
      inferredFromPost: keyword.inferredFromPost,
      mediaId: keyword.mediaId,
    });

    // Their inbound DM already opened the 24h messaging window (Meta-verified),
    // so a known follower — or anyone who already completed this keyword — gets
    // the guide immediately. The "follow and reply DONE" gate is pure friction
    // there; it stays only for non-followers/unknowns, where it's the one
    // leverage moment for the follow ask.
    //
    // `alreadyCompleted` is read above, before the match is trusted, because the same
    // answer decides whether this is a redelivery at all.

    // ---- Strict follower gate V2 --------------------------------------------
    // Both of the V1 conditions below are disqualified evidence: `isFollower` is
    // a cached Graph value, and `alreadyCompleted` authorizes a redelivery on the
    // strength of a past send. The strict path replaces both with a live check.
    if (strictGateOwnerFor(senderId, keyword.resource.id) === "v2") {
      await runStrictGuideRequest({
        conversationId: keywordConversation.id,
        senderId,
        resourceId: keyword.resource.id,
        guideName: keyword.resource.name,
        redelivery: alreadyCompleted,
        inboundMessageId: inbound.messageId,
        threadId: inbound.threadId,
        observedAt,
      });
      return;
    }

    if (profile.isFollower === true || alreadyCompleted) {
      try {
        await deliverOwnedGuide({
          conversationId: keywordConversation.id,
          resourceId: keyword.resource.id,
          messages: keyword.resource.messages,
          senderId,
          threadId: inbound.threadId,
          triggerId: inbound.messageId,
          triggeredAt: observedAt,
          followerAtTrigger: profile.isFollower,
          triggerKind: alreadyCompleted ? "explicit_redelivery" : "inbound_reply",
          ...(alreadyCompleted ? { redeliveryIntro: REDELIVERY_INTRO } : {}),
          legacyEventContext: {
            source: "dm_instant",
            redelivery: alreadyCompleted,
          },
          sendClosingNudge: true,
        });
      } catch (err) {
        // Conversation stays awaiting_done, so any follow-up reply from the user
        // re-attempts delivery via the open-gate branch below.
        logger.error(
          { ...graphFailureMetadata(err), conversationId: keywordConversation.id },
          "Instant DM sequence failed",
        );
        await logEvent("sequence_failed", {
          conversationId: keywordConversation.id,
          source: "dm_instant",
          ...graphFailureMetadata(err),
        });
      }
      return;
    }

    try {
      // The cover goes FIRST, so the ask arrives under a picture of what is on offer.
      // Outside the try/catch that guards the gate on purpose: it swallows its own
      // failures and reports whether the parent actually saw it, so a cover problem can
      // never cost them the gate message that converts.
      await sendCoverBeforeGate({
        conversationId: keywordConversation.id,
        resourceId: keyword.resource.id,
        recipientIgUserId: senderId,
        messages: keyword.resource.messages,
      });
      await sendTrackedText({
        recipientIgUserId: senderId,
        text: keyword.gateMessage,
        source: "keyword_automation",
      });
      // Stamp gatedAt so the DONE-window runs from delivery — aligns the DM path
      // with the comment path's markGated behavior.
      await markGated(keywordConversation.id);
      // The gate IS our answer to this inbound, so the thread no longer needs the
      // owner's attention.
      await markThreadResolved({
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
      });
      await logEvent("dm_sent", { conversationId: keywordConversation.id, kind: "gate", source: "dm" });
    } catch (err) {
      logger.warn(graphFailureMetadata(err), "Gate DM (from inbound message) failed");
      await logEvent("dm_failed", {
        conversationId: keywordConversation.id,
        stage: "gate_inbound_dm",
        senderId,
        ...graphFailureMetadata(err),
      });
    }
    return;
  }

  // ---- 2. Explicit confirmation of an OPEN request → continue it ----------
  // Under enforcement, unrelated text/media never count as confirmation and a
  // classifier fault never falls back to the permissive legacy route.
  if (convo && (!enforced || acceptedReply)) {
    // ---- Strict follower gate V2 --------------------------------------------
    // With rich controls off — the only mode available until the capability rows
    // are `supported` — the strict opening is text ("Want me to send it here?"),
    // so the parent's answer arrives here as an ordinary reply, not a quick
    // reply. `openConversationIn` already creates the conversation as
    // awaiting_done with a null gatedAt, and `findActiveAwaitingDone` accepts
    // that, so without this fence V1 would authorize the reply on cached follow
    // state — including its documented rule that an unreadable null falls through
    // to delivery. The strict gate forbids exactly that.
    if (strictGateOwnerFor(senderId, convo.keyword.resource.id) === "v2") {
      await runStrictGuideRequest({
        conversationId: convo.id,
        senderId,
        resourceId: convo.keyword.resource.id,
        guideName: convo.keyword.resource.name,
        redelivery: await hasCompletedKeyword(senderId, convo.keywordId),
        inboundMessageId: inbound.messageId,
        threadId: inbound.threadId,
        observedAt,
      });
      return;
    }

    // Duplicate guard: the user already completed this keyword (e.g. commented
    // "sleep" on two reels → two open gates). The old behavior closed the gate
    // silently — an unlock instruction followed by nothing, for our most engaged
    // users. Now: acknowledge and redeliver.
    if (await hasCompletedKeyword(senderId, convo.keywordId)) {
      logger.info(
        { conversationId: convo.id, keyword: convo.keyword.keyword, senderId },
        "Open-gate reply for an already-delivered keyword — redelivering",
      );
      try {
        await deliverOwnedGuide({
          conversationId: convo.id,
          resourceId: convo.keyword.resource.id,
          messages: withoutAlreadyShownCover(
            convo.keyword.resource.messages,
            await wasCoverShownAtGate(convo.id),
          ),
          senderId,
          threadId: inbound.threadId,
          triggerId: inbound.messageId,
          triggeredAt: observedAt,
          followerAtTrigger: profile.isFollower,
          triggerKind: "explicit_redelivery",
          redeliveryIntro: REDELIVERY_INTRO,
          legacyEventContext: { redelivery: true },
          sendClosingNudge: false,
        });
      } catch (err) {
        logger.error(
          { ...graphFailureMetadata(err), conversationId: convo.id },
          "Redelivery failed",
        );
        await logEvent("sequence_failed", {
          conversationId: convo.id,
          redelivery: true,
          ...graphFailureMetadata(err),
        });
      }
      return;
    }

    // Hard follow gate: a confirmed non-follower must follow before we deliver.
    // isFollower is reliably readable here — they've messaged us, so consent is
    // granted (0 unknowns across 248 live reads). We ENFORCE only on a confirmed
    // `false`; a rare unreadable `null` (~0.4%) falls through to delivery, since
    // we can't gate what we can't measure and mustn't trap them. We re-arm the
    // window (markGated) so an engaged user has a fresh 48h to follow, and the
    // next reply re-reads a fresh follow flag — covering the follow-flag lag.
    if (profile.isFollower === false) {
      logger.info(
        { conversationId: convo.id, keyword: convo.keyword.keyword, senderId },
        "Open-gate reply from a non-follower — withholding guide until they follow",
      );
      await logEvent("follow_required", {
        conversationId: convo.id,
        keyword: convo.keyword.keyword,
        senderId,
        recoveredInactiveGate,
      });
      try {
        await sendTrackedText({
          recipientIgUserId: senderId,
          text: FOLLOW_GATE,
          source: "keyword_automation",
        });
        await markGated(convo.id); // reset the 48h DONE-window from this reply
        // We answered them (with the follow ask), so this inbound is handled.
        await markThreadResolved({
          threadId: inbound.threadId,
          inboundMessageId: inbound.messageId,
        });
      } catch (err) {
        logger.warn(
          { ...graphFailureMetadata(err), conversationId: convo.id },
          "Follow-required message failed",
        );
      }
      return; // stays awaiting_done — they follow, reply again, and get it
    }

    logger.info(
      { conversationId: convo.id, keyword: convo.keyword.keyword, senderId, mid: msg.mid },
      "Open-gate reply — delivering sequence",
    );
    await logEvent("done_received", {
      conversationId: convo.id,
      senderId,
      mid: msg.mid,
      messageType,
      textLength: text.length,
      matched: enforced ? "accepted_confirmation" : "any_reply",
      looksLikeDone: DONE_RE.test(text),
      recoveredInactiveGate,
    });

    try {
      await deliverOwnedGuide({
        conversationId: convo.id,
        resourceId: convo.keyword.resource.id,
        messages: withoutAlreadyShownCover(
          convo.keyword.resource.messages,
          await wasCoverShownAtGate(convo.id),
        ),
        senderId,
        threadId: inbound.threadId,
        triggerId: inbound.messageId,
        triggeredAt: observedAt,
        followerAtTrigger: profile.isFollower,
        triggerKind: "inbound_reply",
        legacyEventContext: {},
        sendClosingNudge: true,
      });
    } catch (err) {
      logger.error(
        { ...graphFailureMetadata(err), conversationId: convo.id },
        "Sequence failed",
      );
      await logEvent("sequence_failed", {
        conversationId: convo.id,
        ...graphFailureMetadata(err),
      });
    }
    return;
  }

  // ---- 3. No accepted automation intent → queue a draft for the owner -------
  // Historically this branch was silent: 673 people wrote something real and got
  // nothing back. It now queues an AI draft for the owner to approve. Nothing is
  // sent from here — approval is a separate, explicit action, which is also what
  // keeps a considered reply inside Meta's rules.
  logger.debug(
    { senderId, mid: msg.mid, messageType, textLength: text.length },
    "Inbound DM requires owner review",
  );
  await logEvent("message_unhandled", {
    senderId,
    mid: msg.mid,
    textLength: text.length,
    hadOpenConversation: convo !== null,
  });

  if (!flags.bool("AI_DRAFTS_ENABLED")) return;
  try {
    await queueReplyDraft({
      threadId: inbound.threadId,
      inboundMessageId: inbound.messageId,
    });
  } catch (err) {
    // A draft is an assist, never a requirement. Failing here must not fail the
    // webhook — Meta would retry it and we would re-run everything above.
    logger.error(
      { errorCode: "draft_queue_failed", threadId: inbound.threadId },
      "Failed to queue reply draft",
    );
  }
}
