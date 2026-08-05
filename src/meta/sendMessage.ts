import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { MetaSendResult } from "../types/meta.js";

interface GraphSendResponse {
  message_id?: string;
}

/**
 * Both senders now return Meta's `message_id` so an outbound DM can be recorded
 * against the thread it belongs to. Existing callers may ignore the return value —
 * the signature is additive, and nothing about delivery changed.
 */
export async function sendTextMessage(
  recipientIgUserId: string,
  text: string,
): Promise<MetaSendResult> {
  const { data } = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, {
    recipient: { id: recipientIgUserId },
    message: { text },
  });
  logger.debug({ recipientIgUserId, length: text.length }, "Sent text DM");
  return { messageId: data.message_id ?? null };
}

export async function sendPrivateReply(
  commentId: string,
  text: string,
): Promise<MetaSendResult> {
  const { data } = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
  logger.debug({ commentId, length: text.length }, "Sent private reply to comment");
  return { messageId: data.message_id ?? null };
}
