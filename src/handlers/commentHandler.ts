import type { CommentValue } from "../types/meta.js";
import { extractKeyword, findActiveKeyword } from "../services/keywordService.js";
import { openConversation } from "../services/conversationService.js";
import { replyToComment } from "../meta/replyToComment.js";
import { sendPrivateReply } from "../meta/sendMessage.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

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

  const candidate = extractKeyword(comment.text);
  if (!candidate) return;

  const keyword = await findActiveKeyword(candidate);
  if (!keyword) {
    log.debug({ candidate }, "No matching active keyword");
    return;
  }

  log.info({ keyword: keyword.keyword }, "Keyword matched");

  await prisma.eventLog.create({
    data: { kind: "comment_received", payload: comment as object },
  });

  try {
    await replyToComment(comment.id, keyword.publicReply);
  } catch (err) {
    log.warn({ err }, "Public reply failed (non-fatal)");
  }

  const convo = await openConversation(senderId, keyword.id);
  log.info({ conversationId: convo.id }, "Conversation opened");

  await sendPrivateReply(comment.id, keyword.gateMessage);

  await prisma.eventLog.create({
    data: { kind: "dm_sent", payload: { conversationId: convo.id, kind: "gate" } },
  });
}
