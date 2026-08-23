import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { MetaSendResult } from "../types/meta.js";

interface GraphSendResponse {
  message_id?: string;
}

export type MetaMessagePayload = {
  recipient: { id: string } | { comment_id: string };
  messaging_type?: "RESPONSE";
  message: unknown;
};

export type SafeMetaMessageLog = {
  recipientId?: string;
  commentId?: string;
  mode: string;
  messageLength: number;
};

/**
 * Shared Meta send boundary. Its companion metadata deliberately permits only
 * routing IDs and delivery metadata so outbound copy, controls and URLs cannot
 * enter application logs.
 */
export async function sendMetaMessage(
  payload: MetaMessagePayload,
  metadata: SafeMetaMessageLog,
): Promise<MetaSendResult> {
  const { data } = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, payload);
  const providerMessageId = typeof data.message_id === "string" ? data.message_id : null;
  logger.debug(
    {
      ...(metadata.recipientId ? { recipientId: metadata.recipientId } : {}),
      ...(metadata.commentId ? { commentId: metadata.commentId } : {}),
      mode: metadata.mode,
      messageLength: metadata.messageLength,
      providerMessageId,
    },
    "Sent Meta message",
  );
  return { messageId: providerMessageId };
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
  return sendMetaMessage(
    { recipient: { id: recipientIgUserId }, message: { text } },
    { recipientId: recipientIgUserId, mode: "text", messageLength: text.length },
  );
}

export async function sendPrivateReply(
  commentId: string,
  text: string,
): Promise<MetaSendResult> {
  return sendMetaMessage(
    { recipient: { comment_id: commentId }, message: { text } },
    { commentId, mode: "private_text", messageLength: text.length },
  );
}
