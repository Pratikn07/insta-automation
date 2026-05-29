import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export async function sendTextMessage(recipientIgUserId: string, text: string): Promise<void> {
  await graph.post(`/${env.IG_USER_ID}/messages`, {
    recipient: { id: recipientIgUserId },
    message: { text },
  });
  logger.debug({ recipientIgUserId, length: text.length }, "Sent text DM");
}

export async function sendPrivateReply(commentId: string, text: string): Promise<void> {
  await graph.post(`/${env.IG_USER_ID}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
  logger.debug({ commentId, length: text.length }, "Sent private reply to comment");
}
