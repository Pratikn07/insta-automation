import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { recordRecoveryPostback } from "../services/dmRecoveryService.js";

function parseEventTime(rawTimestamp: number | undefined): Date {
  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return new Date(rawTimestamp);
  }
  return new Date();
}

export async function handlePostback(entry: MessagingEntry): Promise<void> {
  const postback = entry.postback;
  if (!postback) {
    logger.debug({ senderId: entry.sender?.id }, "Postback webhook entry missing postback payload");
    return;
  }

  if (!postback.mid) {
    logger.info(
      { senderId: entry.sender?.id, payload: postback.payload },
      "Postback webhook entry missing mid — acknowledged without exact message correlation",
    );
    return;
  }

  const eventAt = parseEventTime(entry.timestamp);
  const receivedAt = new Date();

  await recordRecoveryPostback({
    instagramMessageId: postback.mid,
    eventAt,
    receivedAt,
  });
}
