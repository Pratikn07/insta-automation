import type { DmMessageType } from "@prisma/client";
import type { MessagingEntry } from "../types/meta.js";
import {
  findActiveAwaitingDone,
  findLatestIncompleteConversation,
  hasCompletedKeyword,
  markCompleted,
  markGated,
  openConversation,
} from "../services/conversationService.js";
import { findKeywordInMessage } from "../services/keywordService.js";
import { sendSequence } from "../services/sequenceSender.js";
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
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { resolveUsername } from "../services/igUserService.js";
import { env } from "../config/env.js";

// Kept only as an analytics hint now — it is NO LONGER the trigger. Any reply to
// an open gate delivers the guide (people say "Hi"/"Followed"/"Yes", not "Done").
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
  if (!env.AI_FOLLOW_UPS_ENABLED) return;

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

  const senderId = entry.sender.id;
  if (senderId === env.IG_USER_ID) return;

  if (msg.is_deleted) {
    await markInboundDeleted(msg.mid, new Date(entry.timestamp));
    return;
  }

  const text = msg.text ?? "";

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
    instagramTimestamp: new Date(entry.timestamp),
  });
  if (inbound.duplicate) {
    logger.debug(
      { senderId, mid: msg.mid, duplicate: true },
      "Inbound webhook ignored (duplicate)",
    );
    return;
  }

  // Record recovery inbound evidence for any newly captured inbound message (even if delayed)
  const recoveryKind = msg.quick_reply?.payload
    ? "quick_reply"
    : msg.attachments?.length
      ? "attachment"
      : "inbound_reply";
  await recordRecoveryInbound({
    igUserId: senderId,
    eventAt: new Date(entry.timestamp),
    receivedAt: new Date(),
    kind: recoveryKind,
  });

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

  // ---- 1. New keyword → (re)send the gate ----------------------------------
  // Checked FIRST so someone with an open "sleep" gate who DMs "potty" starts a
  // potty gate rather than completing the sleep one.
  const keyword = await findKeywordInMessage(text);
  if (keyword) {
    const convo = await openConversation(senderId, keyword.id);
    logger.info(
      {
        conversationId: convo.id,
        keyword: keyword.keyword,
        senderId,
        inferredFromPost: keyword.inferredFromPost,
      },
      "Keyword matched in DM",
    );
    await logEvent("keyword_matched", {
      conversationId: convo.id,
      keyword: keyword.keyword,
      source: "dm",
      senderId,
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
    const alreadyCompleted = await hasCompletedKeyword(senderId, keyword.id);
    if (profile.isFollower === true || alreadyCompleted) {
      try {
        if (alreadyCompleted) {
          await sendTrackedText({
            recipientIgUserId: senderId,
            text: REDELIVERY_INTRO,
            source: "keyword_automation",
          });
        }
        await sendSequence({
          igUserId: senderId,
          messages: keyword.resource.messages,
          source: "guide_automation",
        });
        const completed = await markCompleted(convo.id);
        await scheduleFollowUpAfterDelivery({
          conversationId: convo.id,
          threadId: inbound.threadId,
          inboundMessageId: inbound.messageId,
          inboundAt: new Date(entry.timestamp),
          deliveredAt: completed.completedAt,
        });
        await markThreadResolved({
          threadId: inbound.threadId,
          inboundMessageId: inbound.messageId,
        });
        await logEvent("sequence_completed", {
          conversationId: convo.id,
          followerAtDelivery: profile.isFollower,
          source: "dm_instant",
          redelivery: alreadyCompleted,
        });

        // Same follow-aware sign-off as the gated path; best-effort.
        try {
          const closing = profile.isFollower ? FOLLOWER_THANKS : FOLLOW_NUDGE;
          await sendTrackedText({
            recipientIgUserId: senderId,
            text: closing,
            source: "guide_automation",
          });
          await logEvent("follow_nudge_sent", {
            conversationId: convo.id,
            isFollower: profile.isFollower,
            variant: profile.isFollower ? "thanks" : "nudge",
          });
        } catch (err) {
          logger.warn(
            { ...graphFailureMetadata(err), conversationId: convo.id },
            "Follow-aware closing message failed (guide already delivered)",
          );
        }
      } catch (err) {
        // Conversation stays awaiting_done, so any follow-up reply from the user
        // re-attempts delivery via the open-gate branch below.
        logger.error(
          { ...graphFailureMetadata(err), conversationId: convo.id },
          "Instant DM sequence failed",
        );
        await logEvent("sequence_failed", {
          conversationId: convo.id,
          source: "dm_instant",
          ...graphFailureMetadata(err),
        });
      }
      return;
    }

    try {
      await sendTrackedText({
        recipientIgUserId: senderId,
        text: keyword.gateMessage,
        source: "keyword_automation",
      });
      // Stamp gatedAt so the DONE-window runs from delivery — aligns the DM path
      // with the comment path's markGated behavior.
      await markGated(convo.id);
      // The gate IS our answer to this inbound, so the thread no longer needs the
      // owner's attention.
      await markThreadResolved({
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
      });
      await logEvent("dm_sent", { conversationId: convo.id, kind: "gate", source: "dm" });
    } catch (err) {
      logger.warn(graphFailureMetadata(err), "Gate DM (from inbound message) failed");
      await logEvent("dm_failed", {
        conversationId: convo.id,
        stage: "gate_inbound_dm",
        senderId,
        ...graphFailureMetadata(err),
      });
    }
    return;
  }

  // ---- 2. Any reply to an OPEN gate → continue the request ----------------
  // The user received the gate and replied with intent — regardless of the exact
  // wording ("Hi", "Followed", "Yes", a sticker, or "Done"). This is the flexible
  // matching that recovers the users who never typed the magic word. When the
  // internal gate has expired, only an explicit DONE recovers the latest request;
  // that fresh inbound message opens Meta's current 24-hour sending window.
  let convo = await findActiveAwaitingDone(senderId);
  let recoveredInactiveGate = false;
  if (!convo && DONE_RE.test(text)) {
    convo = await findLatestIncompleteConversation(senderId);
    recoveredInactiveGate = convo !== null;
  }
  if (convo) {
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
        await sendTrackedText({
          recipientIgUserId: senderId,
          text: REDELIVERY_INTRO,
          source: "keyword_automation",
        });
        await sendSequence({
          igUserId: senderId,
          messages: convo.keyword.resource.messages,
          source: "guide_automation",
        });
        const completed = await markCompleted(convo.id);
        await scheduleFollowUpAfterDelivery({
          conversationId: convo.id,
          threadId: inbound.threadId,
          inboundMessageId: inbound.messageId,
          inboundAt: new Date(entry.timestamp),
          deliveredAt: completed.completedAt,
        });
        await markThreadResolved({
          threadId: inbound.threadId,
          inboundMessageId: inbound.messageId,
        });
        await logEvent("sequence_completed", {
          conversationId: convo.id,
          followerAtDelivery: profile.isFollower,
          redelivery: true,
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
      matched: "any_reply",
      looksLikeDone: DONE_RE.test(text),
      recoveredInactiveGate,
    });

    try {
      await sendSequence({
        igUserId: senderId,
        messages: convo.keyword.resource.messages,
        source: "guide_automation",
      });
      const completed = await markCompleted(convo.id);
      await scheduleFollowUpAfterDelivery({
        conversationId: convo.id,
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
        inboundAt: new Date(entry.timestamp),
        deliveredAt: completed.completedAt,
      });
      await markThreadResolved({
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
      });
      await logEvent("sequence_completed", {
        conversationId: convo.id,
        followerAtDelivery: profile.isFollower,
      });

      // Follow-aware closing nudge (hybrid): guide already delivered above; this
      // only tailors the sign-off. Non-follower OR unknown → ask for the follow.
      // Best-effort — a failure here must not undo the completed delivery.
      try {
        const closing = profile.isFollower ? FOLLOWER_THANKS : FOLLOW_NUDGE;
        await sendTrackedText({
          recipientIgUserId: senderId,
          text: closing,
          source: "guide_automation",
        });
        await logEvent("follow_nudge_sent", {
          conversationId: convo.id,
          isFollower: profile.isFollower,
          variant: profile.isFollower ? "thanks" : "nudge",
        });
      } catch (err) {
        logger.warn(
          { ...graphFailureMetadata(err), conversationId: convo.id },
          "Follow-aware closing message failed (guide already delivered)",
        );
      }
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

  // ---- 3. No keyword, no open gate → queue a draft for the owner ------------
  // Historically this branch was silent: 673 people wrote something real and got
  // nothing back. It now queues an AI draft for the owner to approve. Nothing is
  // sent from here — approval is a separate, explicit action, which is also what
  // keeps a considered reply inside Meta's rules.
  logger.debug(
    { senderId, mid: msg.mid, messageType, textLength: text.length },
    "Inbound DM with no keyword and no open gate",
  );
  await logEvent("message_unhandled", {
    senderId,
    mid: msg.mid,
    textLength: text.length,
    hadOpenConversation: false,
  });

  if (!env.AI_DRAFTS_ENABLED) return;
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
