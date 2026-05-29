import type { MessagingEntry } from "../types/meta.js";
import { findActiveAwaitingDone, markCompleted } from "../services/conversationService.js";
import { sendSequence } from "../services/sequenceSender.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

const DONE_RE = /^\s*done\s*[!.]*\s*$/i;

export async function handleMessage(entry: MessagingEntry): Promise<void> {
  const msg = entry.message;
  if (!msg || msg.is_echo) return;

  const senderId = entry.sender.id;
  if (senderId === env.IG_USER_ID) return;

  const text = msg.text ?? "";
  if (!DONE_RE.test(text)) {
    logger.debug({ senderId, text }, "Message did not match DONE");
    return;
  }

  const convo = await findActiveAwaitingDone(senderId);
  if (!convo) {
    logger.debug({ senderId }, "DONE received but no awaiting_done conversation found");
    return;
  }

  logger.info({ conversationId: convo.id, keyword: convo.keyword.keyword }, "DONE matched");

  await prisma.eventLog.create({
    data: { kind: "done_received", payload: { conversationId: convo.id } },
  });

  await sendSequence(senderId, convo.keyword.resource.messages);
  await markCompleted(convo.id);

  await prisma.eventLog.create({
    data: { kind: "sequence_completed", payload: { conversationId: convo.id } },
  });
}
