import type { MessagingEntry } from "../types/meta.js";
import {
  findActiveAwaitingDone,
  hasCompletedKeyword,
  markCompleted,
  markGated,
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
// Sent before redelivering a guide the user already received — replaces the old
// silent skip, which left our most engaged users with no response at all.
const REDELIVERY_INTRO = "You've already got this one — here it is again 💛";
// Hard follow gate: shown when a confirmed non-follower replies to the gate. The
// parenthetical pre-empts the follow-flag lag (a real tap can take minutes to
// register), so someone who just followed knows to simply reply again.
const FOLLOW_GATE =
  "You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over. (Just followed? Give it a few seconds and reply DONE again.)";

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
        if (alreadyCompleted) await sendTextMessage(senderId, REDELIVERY_INTRO);
        await sendSequence(senderId, keyword.resource.messages);
        await markCompleted(convo.id);
        await logEvent("sequence_completed", {
          conversationId: convo.id,
          followerAtDelivery: profile.isFollower,
          source: "dm_instant",
          redelivery: alreadyCompleted,
        });

        // Same follow-aware sign-off as the gated path; best-effort.
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
        // Conversation stays awaiting_done, so any follow-up reply from the user
        // re-attempts delivery via the open-gate branch below.
        logger.error({ ...describeGraphError(err), conversationId: convo.id }, "Instant DM sequence failed");
        await logEvent("sequence_failed", {
          conversationId: convo.id,
          source: "dm_instant",
          ...describeGraphError(err),
        });
      }
      return;
    }

    try {
      await sendTextMessage(senderId, keyword.gateMessage);
      // Stamp gatedAt so the DONE-window runs from delivery — aligns the DM path
      // with the comment path's markGated behavior.
      await markGated(convo.id);
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
        await sendTextMessage(senderId, REDELIVERY_INTRO);
        await sendSequence(senderId, convo.keyword.resource.messages);
        await markCompleted(convo.id);
        await logEvent("sequence_completed", {
          conversationId: convo.id,
          followerAtDelivery: profile.isFollower,
          redelivery: true,
        });
      } catch (err) {
        logger.error({ ...describeGraphError(err), conversationId: convo.id }, "Redelivery failed");
        await logEvent("sequence_failed", {
          conversationId: convo.id,
          redelivery: true,
          ...describeGraphError(err),
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
      });
      try {
        await sendTextMessage(senderId, FOLLOW_GATE);
        await markGated(convo.id); // reset the 48h DONE-window from this reply
      } catch (err) {
        logger.warn(
          { ...describeGraphError(err), conversationId: convo.id },
          "Follow-required message failed",
        );
      }
      return; // stays awaiting_done — they follow, reply again, and get it
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
