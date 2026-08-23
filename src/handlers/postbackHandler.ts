import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { parseProviderTimestamp } from "../lib/providerTime.js";
import { recordRecoveryPostback } from "../services/dmRecoveryService.js";

export async function handlePostback(entry: MessagingEntry): Promise<void> {
  const postback = entry.postback;
  if (!postback) {
    logger.debug({ senderId: entry.sender?.id }, "Postback webhook entry missing postback payload");
    return;
  }

  if (!postback.mid) {
    logger.info(
      { senderId: entry.sender?.id },
      "Postback webhook entry missing mid — acknowledged without exact message correlation",
    );
    return;
  }

  const receivedAt = new Date();
  const eventAt = parseProviderTimestamp(entry.timestamp, receivedAt);

  await recordRecoveryPostback({
    instagramMessageId: postback.mid,
    eventAt,
    receivedAt,
  });
}
