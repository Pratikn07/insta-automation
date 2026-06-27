import type { CommentValue } from "../types/meta.js";
import { extractKeyword, findActiveKeyword } from "../services/keywordService.js";
import { openConversation, markGated } from "../services/conversationService.js";
import { replyToComment } from "../meta/replyToComment.js";
import { sendPrivateReply } from "../meta/sendMessage.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { rememberUsername } from "../services/igUserService.js";
import { enqueueGate } from "../services/gateQueueService.js";

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

  const candidate = extractKeyword(comment.text);
  if (!candidate) return;

  const keyword = await findActiveKeyword(candidate, comment.media?.id);
  if (!keyword) {
    log.debug({ candidate, mediaId: comment.media?.id }, "No matching active keyword");
    await logEvent("comment_ignored", {
      commentId: comment.id,
      candidate,
      mediaId: comment.media?.id ?? null,
    });
    return;
  }

  log.info(
    { keyword: keyword.keyword, scope: keyword.mediaId ? "reel" : "global", mediaId: comment.media?.id },
    "Keyword matched",
  );

  const convo = await openConversation(senderId, keyword.id);
  log.info({ conversationId: convo.id }, "Conversation opened");

  await logEvent("keyword_matched", {
    conversationId: convo.id,
    commentId: comment.id,
    parentId: comment.parent_id ?? null,
    keyword: keyword.keyword,
    scope: keyword.mediaId ? "reel" : "global",
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
