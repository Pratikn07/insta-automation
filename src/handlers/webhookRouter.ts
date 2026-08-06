import type { WebhookPayload } from "../types/meta.js";
import { handleComment } from "./commentHandler.js";
import { handleMessage } from "./messageHandler.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";

function handlerFailureMetadata(
  err: unknown,
  errorCode: "comment_handler_failed" | "message_handler_failed",
): Record<string, unknown> {
  return { errorCode, ...describeGraphError(err) };
}

export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
  if (payload.object !== "instagram") {
    logger.debug({ object: payload.object }, "Ignoring non-instagram webhook");
    return;
  }

  const entries = payload.entry ?? [];
  await logEvent("webhook_received", {
    object: payload.object,
    entryCount: entries.length,
    messagingCount: entries.reduce((count, entry) => count + (entry.messaging?.length ?? 0), 0),
    changeCount: entries.reduce((count, entry) => count + (entry.changes?.length ?? 0), 0),
  });

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        try {
          await handleComment(change.value);
        } catch (err) {
          const failure = handlerFailureMetadata(err, "comment_handler_failed");
          logger.error({ ...failure, commentId: change.value?.id ?? null }, "commentHandler failed");
          await logEvent("error", {
            stage: "commentHandler",
            commentId: change.value?.id ?? null,
            ...failure,
          });
        }
      }
    }

    for (const m of entry.messaging ?? []) {
      try {
        await handleMessage(m);
      } catch (err) {
        const failure = handlerFailureMetadata(err, "message_handler_failed");
        logger.error({ ...failure, senderId: m.sender?.id ?? null }, "messageHandler failed");
        await logEvent("error", {
          stage: "messageHandler",
          senderId: m.sender?.id ?? null,
          ...failure,
        });
      }
    }
  }
}
