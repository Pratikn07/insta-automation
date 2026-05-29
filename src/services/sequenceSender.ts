import type { ResourceMessage } from "@prisma/client";
import { sendTextMessage } from "../meta/sendMessage.js";
import { sendMedia } from "../meta/sendMedia.js";
import { logger } from "../lib/logger.js";

const STEP_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendSequence(igUserId: string, messages: ResourceMessage[]): Promise<void> {
  const ordered = [...messages].sort((a, b) => a.order - b.order);

  for (const m of ordered) {
    try {
      if (m.type === "text") {
        if (!m.body) continue;
        await sendTextMessage(igUserId, m.body);
      } else if (m.type === "image") {
        if (!m.mediaUrl) continue;
        await sendMedia({ recipientIgUserId: igUserId, type: "image", url: m.mediaUrl });
        if (m.body) await sendTextMessage(igUserId, m.body);
      } else if (m.type === "pdf") {
        if (!m.mediaUrl) continue;
        await sendMedia({ recipientIgUserId: igUserId, type: "file", url: m.mediaUrl });
        if (m.body) await sendTextMessage(igUserId, m.body);
      }
      await sleep(STEP_DELAY_MS);
    } catch (err) {
      logger.error({ err, step: m.id, type: m.type }, "Sequence step failed");
      throw err;
    }
  }
}
