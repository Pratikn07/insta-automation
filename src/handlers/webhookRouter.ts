import type { MessagingEntry, WebhookPayload } from "../types/meta.js";
import { handleComment } from "./commentHandler.js";
import { handleMessage } from "./messageHandler.js";
import { handleSeen } from "./seenHandler.js";
import { handleReaction } from "./reactionHandler.js";
import { handlePostback } from "./postbackHandler.js";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";

function handlerFailureMetadata(
  err: unknown,
  errorCode:
    | "comment_handler_failed"
    | "message_handler_failed"
    | "seen_handler_failed"
    | "reaction_handler_failed"
    | "postback_handler_failed",
): Record<string, unknown> {
  return { errorCode, ...describeGraphError(err) };
}

export async function routeMessagingEntry(m: MessagingEntry): Promise<void> {
  if (m.read) {
    try {
      await handleSeen(m);
    } catch (err) {
      const failure = handlerFailureMetadata(err, "seen_handler_failed");
      logger.error({ ...failure, senderId: m.sender?.id ?? null }, "seenHandler failed");
      await logEvent("error", { stage: "seenHandler", senderId: m.sender?.id ?? null, ...failure });
    }
    return;
  }

  if (m.reaction) {
    try {
      await handleReaction(m);
    } catch (err) {
      const failure = handlerFailureMetadata(err, "reaction_handler_failed");
      logger.error({ ...failure, senderId: m.sender?.id ?? null }, "reactionHandler failed");
      await logEvent("error", { stage: "reactionHandler", senderId: m.sender?.id ?? null, ...failure });
    }
    return;
  }

  if (m.postback) {
    try {
      await handlePostback(m);
    } catch (err) {
      const failure = handlerFailureMetadata(err, "postback_handler_failed");
      logger.error({ ...failure, senderId: m.sender?.id ?? null }, "postbackHandler failed");
      await logEvent("error", { stage: "postbackHandler", senderId: m.sender?.id ?? null, ...failure });
    }
    return;
  }

  if (m.message) {
    try {
      await handleMessage(m);
    } catch (err) {
      const failure = handlerFailureMetadata(err, "message_handler_failed");
      logger.error({ ...failure, senderId: m.sender?.id ?? null }, "messageHandler failed");
      await logEvent("error", { stage: "messageHandler", senderId: m.sender?.id ?? null, ...failure });
    }
    return;
  }

  logger.info({ senderId: m.sender?.id }, "Unrecognized messaging entry payload — acknowledged safely");
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
      await routeMessagingEntry(m);
    }
  }
}
