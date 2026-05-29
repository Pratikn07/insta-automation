import type { WebhookPayload } from "../types/meta.js";
import { handleComment } from "./commentHandler.js";
import { handleMessage } from "./messageHandler.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
  if (payload.object !== "instagram") {
    logger.debug({ object: payload.object }, "Ignoring non-instagram webhook");
    return;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        try {
          await handleComment(change.value);
        } catch (err) {
          logger.error({ err }, "commentHandler failed");
          await prisma.eventLog.create({
            data: { kind: "error", payload: { stage: "commentHandler", err: String(err) } },
          });
        }
      }
    }

    for (const m of entry.messaging ?? []) {
      try {
        await handleMessage(m);
      } catch (err) {
        logger.error({ err }, "messageHandler failed");
        await prisma.eventLog.create({
          data: { kind: "error", payload: { stage: "messageHandler", err: String(err) } },
        });
      }
    }
  }
}
