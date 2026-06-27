import type { WebhookPayload } from "../types/meta.js";
import { handleComment } from "./commentHandler.js";
import { handleMessage } from "./messageHandler.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";

export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
  if (payload.object !== "instagram") {
    logger.debug({ object: payload.object }, "Ignoring non-instagram webhook");
    return;
  }

  // Capture the complete, untouched payload before any processing. This is the
  // raw record of everything Instagram sends us — including duplicate
  // deliveries, our own comments, echoes, and unmatched events.
  await logEvent("webhook_received", { payload: payload as object });

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        try {
          await handleComment(change.value);
        } catch (err) {
          logger.error(describeGraphError(err), "commentHandler failed");
          await logEvent("error", {
            stage: "commentHandler",
            commentId: change.value?.id ?? null,
            ...describeGraphError(err),
          });
        }
      }
    }

    for (const m of entry.messaging ?? []) {
      try {
        await handleMessage(m);
      } catch (err) {
        logger.error(describeGraphError(err), "messageHandler failed");
        await logEvent("error", {
          stage: "messageHandler",
          senderId: m.sender?.id ?? null,
          ...describeGraphError(err),
        });
      }
    }
  }
}
