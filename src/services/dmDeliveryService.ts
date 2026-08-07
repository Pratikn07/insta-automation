import type { DmMessageSource } from "@prisma/client";
import { sendPrivateReply, sendTextMessage } from "../meta/sendMessage.js";
import { sendMedia } from "../meta/sendMedia.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AttachmentType, MetaSendResult } from "../types/meta.js";
import { recordOutboundMessage } from "./dmThreadService.js";
import type { RecordOutboundInput } from "./dmThreadService.js";

/**
 * Send to Instagram, then record what we sent.
 *
 * THE ordering rule: Instagram first, recording second, in a separate try/catch.
 * A database problem must never make a delivered message look undelivered — that
 * is precisely how a delivered gate DM once became 30+ duplicates, and why
 * GATE_MAX_ATTEMPTS exists.
 *
 * A failed Instagram send records nothing (there is nothing to record) and
 * rethrows, so every existing caller's error handling behaves exactly as before.
 */

/** Meta attachment type → the type we store on the message row. */
const MESSAGE_TYPE: Record<AttachmentType, "image" | "video" | "audio" | "file"> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

import type { RecordedOutboundMessage } from "./dmThreadService.js";

/**
 * Record a delivered message, absorbing any failure here.
 *
 * `recordOutboundMessage` already swallows its own errors, but this wrapper does
 * not *depend* on that: a delivered message must stay delivered even if that
 * contract later changes. Logs IDs, source and length only — never the body.
 */
async function recordDelivered(input: RecordOutboundInput): Promise<RecordedOutboundMessage | null> {
  try {
    return await recordOutboundMessage(input);
  } catch {
    logger.error(
      {
        errorCode: "dm_history_write_failed",
        igUserId: input.igUserId,
        instagramMessageId: input.instagramMessageId,
        source: input.source,
        length: input.text?.length ?? 0,
      },
      "Outbound DM was delivered but could not be recorded",
    );
    return null;
  }
}

export async function sendTrackedText(input: {
  recipientIgUserId: string;
  text: string;
  source: DmMessageSource;
  /** AI-approved sends are recorded later with draft state and audit atomically. */
  history?: "best_effort" | "deferred";
}): Promise<MetaSendResult> {
  const result = await sendTextMessage(input.recipientIgUserId, input.text);
  if (input.history !== "deferred") {
    await recordDelivered({
      igAccountId: env.IG_USER_ID,
      igUserId: input.recipientIgUserId,
      instagramMessageId: result.messageId,
      text: input.text,
      messageType: "text",
      mediaUrl: null,
      source: input.source,
      instagramTimestamp: new Date(),
    });
  }
  return result;
}

export type TrackedPrivateReplyReceipt = {
  instagramMessageId: string | null;
  dmMessageId: string | null;
  acceptedAt: Date;
};

export type TrackedPrivateReplyInput = {
  recipientIgUserId: string;
  commentId: string;
  text: string;
  source: DmMessageSource;
};

/**
 * A private reply is addressed by `comment_id`, but it lands in the participant's
 * DM thread — so the recorded row keys on the recipient, never the comment.
 */
export async function sendTrackedPrivateReply(
  input: TrackedPrivateReplyInput,
): Promise<TrackedPrivateReplyReceipt> {
  const result = await sendPrivateReply(input.commentId, input.text);
  const acceptedAt = new Date();
  const recorded = await recordDelivered({
    igAccountId: env.IG_USER_ID,
    igUserId: input.recipientIgUserId,
    instagramMessageId: result.messageId,
    text: input.text,
    messageType: "text",
    mediaUrl: null,
    source: input.source,
    instagramTimestamp: acceptedAt,
  });
  return {
    instagramMessageId: result.messageId,
    dmMessageId: recorded?.messageId ?? null,
    acceptedAt,
  };
}

export async function sendTrackedMedia(input: {
  recipientIgUserId: string;
  type: AttachmentType;
  url: string;
  source: DmMessageSource;
}): Promise<MetaSendResult> {
  const result = await sendMedia({
    recipientIgUserId: input.recipientIgUserId,
    type: input.type,
    url: input.url,
  });
  await recordDelivered({
    igAccountId: env.IG_USER_ID,
    igUserId: input.recipientIgUserId,
    instagramMessageId: result.messageId,
    text: null,
    messageType: MESSAGE_TYPE[input.type],
    mediaUrl: input.url,
    source: input.source,
    instagramTimestamp: new Date(),
  });
  return result;
}
