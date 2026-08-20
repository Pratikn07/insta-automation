import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AttachmentType, MetaSendResult } from "../types/meta.js";

interface SendMediaArgs {
  recipientIgUserId: string;
  type: AttachmentType;
  url: string;
}

interface GraphSendResponse {
  message_id?: string;
}

export async function sendMedia({
  recipientIgUserId,
  type,
  url,
}: SendMediaArgs): Promise<MetaSendResult> {
  const { data } = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, {
    recipient: { id: recipientIgUserId },
    message: {
      attachment: {
        type,
        payload: { url, is_reusable: false },
      },
    },
  });
  logger.debug({ recipientIgUserId, type }, "Sent media DM");
  return { messageId: data.message_id ?? null };
}
