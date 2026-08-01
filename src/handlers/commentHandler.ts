import type { CommentValue } from "../types/meta.js";
import { extractCandidates, findKeywordForComment } from "../services/keywordService.js";
import { openConversation, markGated } from "../services/conversationService.js";
import { replyToComment } from "../meta/replyToComment.js";
import { sendPrivateReply } from "../meta/sendMessage.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { rememberUsername } from "../services/igUserService.js";
import { enqueueGate } from "../services/gateQueueService.js";
import { env } from "../config/env.js";

/**
 * Human-readable scope for a media-attached keyword, from the webhook's
 * media_product_type. Logged on keyword_matched, so historical "reel" values
 * stay comparable: REELS still reads "reel".
 */
function mediaScopeLabel(productType: string | undefined): string {
  if (productType === "REELS") return "reel";
  if (productType === "FEED") return "carousel";
  return "media";
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
  // to first-word only — see scannableCommentTokens.
  const candidates = extractCandidates(comment.text);
  if (candidates.length === 0) return;

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

  const convo = await openConversation(senderId, keyword.id);
  log.info({ conversationId: convo.id }, "Conversation opened");

  await logEvent("keyword_matched", {
    conversationId: convo.id,
    commentId: comment.id,
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
    await replyToComment(comment.id, keyword.publicReply);
    await logEvent("public_reply_sent", { conversationId: convo.id, commentId: comment.id });
  } catch (err) {
    log.warn(describeGraphError(err), "Public reply failed (non-fatal)");
    await logEvent("public_reply_failed", {
      conversationId: convo.id,
      commentId: comment.id,
      ...describeGraphError(err),
    });
  }

  try {
    await sendPrivateReply(comment.id, keyword.gateMessage);
    // Stamp gatedAt so the DONE-window is measured from delivery (consistent with
    // the retry path). markGated keeps state awaiting_done + sets gatedAt=now.
    await markGated(convo.id);
    await logEvent("dm_sent", { conversationId: convo.id, kind: "gate" });
  } catch (err) {
    // This is the gate private reply — the call that fails with subcode 2534025.
    // Capture the full structured reason plus parentId/commentId, tied to the
    // conversation so it surfaces in the Conversations timeline.
    const detail = describeGraphError(err);
    log.warn(detail, "Gate private reply failed");
    await logEvent("dm_failed", {
      conversationId: convo.id,
      stage: "gate_private_reply",
      commentId: comment.id,
      parentId: comment.parent_id ?? null,
      ...detail,
    });
    // Remember it so the retry worker can re-attempt within the 7-day window —
    // this is what recovers the comment-only users the rate limit otherwise loses.
    await enqueueGate({
      conversationId: convo.id,
      igUserId: senderId,
      commentId: comment.id,
      gateMessage: keyword.gateMessage,
      lastError: typeof detail.message === "string" ? detail.message : undefined,
    });
  }
}
