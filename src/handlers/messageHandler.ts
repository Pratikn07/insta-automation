import type { MessagingEntry } from "../types/meta.js";
import {
  findActiveAwaitingDone,
  hasCompletedKeyword,
  markCompleted,
  openConversation,
} from "../services/conversationService.js";
import { findKeywordInMessage } from "../services/keywordService.js";
import { sendSequence } from "../services/sequenceSender.js";
import { sendTextMessage } from "../meta/sendMessage.js";
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

export async function handleMessage(entry: MessagingEntry): Promise<void> {
  const msg = entry.message;
  if (!msg || msg.is_echo) return;

  const senderId = entry.sender.id;
  if (senderId === env.IG_USER_ID) return;

  const text = msg.text ?? "";

  // Record every inbound DM from a user, before any matching.
  await logEvent("message_received", { senderId, text, mid: msg.mid });

  // DM webhooks don't carry a username — resolve it via the Graph API (non-throwing
  // so it can't break message handling). The same call also returns follow intel
  // (is_user_follow_business), which we use to personalize the guide delivery below.
  const profile = await resolveUsername(senderId);

  // ---- 1. New keyword → (re)send the gate ----------------------------------
  // Checked FIRST so someone with an open "sleep" gate who DMs "potty" starts a
  // potty gate rather than completing the sleep one.
  const keyword = await findKeywordInMessage(text);
  if (keyword) {
    const convo = await openConversation(senderId, keyword.id);
    logger.info({ conversationId: convo.id, keyword: keyword.keyword, senderId }, "Keyword matched in DM");
    await logEvent("keyword_matched", {
      conversationId: convo.id,
      keyword: keyword.keyword,
      source: "dm",
      senderId,
    });

    try {
      await sendTextMessage(senderId, keyword.gateMessage);
      await logEvent("dm_sent", { conversationId: convo.id, kind: "gate", source: "dm" });
    } catch (err) {
      logger.warn(describeGraphError(err), "Gate DM (from inbound message) failed");
      await logEvent("dm_failed", {
        conversationId: convo.id,
        stage: "gate_inbound_dm",
        senderId,
        ...describeGraphError(err),
      });
    }
    return;
  }

  // ---- 2. Any reply to an OPEN gate → deliver the guide --------------------
  // The user received the gate and replied with intent — regardless of the exact
  // wording ("Hi", "Followed", "Yes", a sticker, or "Done"). This is the flexible
  // matching that recovers the users who never typed the magic word.
  const convo = await findActiveAwaitingDone(senderId);
  if (convo) {
    // Idempotency guard: never deliver a keyword's guide twice to the same user
    // (e.g. they commented "sleep" on two reels → two open gates). Close this gate
    // silently and stop — the guide is already in their inbox.
    if (await hasCompletedKeyword(senderId, convo.keywordId)) {
      logger.info(
        { conversationId: convo.id, keyword: convo.keyword.keyword, senderId },
        "Open-gate reply, but user already completed this keyword — skipping (dedupe)",
      );
      await markCompleted(convo.id);
      await logEvent("duplicate_skipped", {
        conversationId: convo.id,
        keyword: convo.keyword.keyword,
        senderId,
        reason: "already_completed_keyword",
      });
      return;
    }

    logger.info(
      { conversationId: convo.id, keyword: convo.keyword.keyword, text },
      "Open-gate reply — delivering sequence",
    );
    await logEvent("done_received", {
      conversationId: convo.id,
      text,
      matched: "any_reply",
      looksLikeDone: DONE_RE.test(text),
    });

    try {
      await sendSequence(senderId, convo.keyword.resource.messages);
      await markCompleted(convo.id);
      await logEvent("sequence_completed", {
        conversationId: convo.id,
        followerAtDelivery: profile.isFollower,
      });

      // Follow-aware closing nudge (hybrid): guide already delivered above; this
      // only tailors the sign-off. Non-follower OR unknown → ask for the follow.
      // Best-effort — a failure here must not undo the completed delivery.
      try {
        const closing = profile.isFollower ? FOLLOWER_THANKS : FOLLOW_NUDGE;
        await sendTextMessage(senderId, closing);
        await logEvent("follow_nudge_sent", {
          conversationId: convo.id,
          isFollower: profile.isFollower,
          variant: profile.isFollower ? "thanks" : "nudge",
        });
      } catch (err) {
        logger.warn(
          { ...describeGraphError(err), conversationId: convo.id },
          "Follow-aware closing message failed (guide already delivered)",
        );
      }
    } catch (err) {
      logger.error({ ...describeGraphError(err), conversationId: convo.id }, "Sequence failed");
      await logEvent("sequence_failed", { conversationId: convo.id, ...describeGraphError(err) });
    }
    return;
  }

  // ---- 3. No keyword, no open gate → nothing to do -------------------------
  // e.g. a "thanks" from an already-completed user (stays silent) or a cold DM.
  logger.debug({ senderId, text }, "Inbound DM with no keyword and no open gate");
  await logEvent("message_unhandled", { senderId, text, hadOpenConversation: false });
}
