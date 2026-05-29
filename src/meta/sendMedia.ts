import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AttachmentType } from "../types/meta.js";

interface SendMediaArgs {
  recipientIgUserId: string;
  type: AttachmentType;
  url: string;
}

export async function sendMedia({ recipientIgUserId, type, url }: SendMediaArgs): Promise<void> {
  await graph.post(`/${env.IG_USER_ID}/messages`, {
    recipient: { id: recipientIgUserId },
    message: {
      attachment: {
        type,
        payload: { url, is_reusable: false },
      },
    },
  });
  logger.debug({ recipientIgUserId, type, url }, "Sent media DM");
}
