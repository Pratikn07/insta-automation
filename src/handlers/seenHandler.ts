import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { parseProviderTimestamp } from "../lib/providerTime.js";
import { markOutboundSeen } from "../services/dmThreadService.js";
import { recordRecoverySeen } from "../services/dmRecoveryService.js";

export async function handleSeen(entry: MessagingEntry): Promise<void> {
  const mid = entry.read?.mid;
  if (!mid) {
    logger.debug({ senderId: entry.sender?.id }, "Seen webhook entry missing read.mid");
    return;
  }

  const receivedAt = new Date();
  const eventAt = parseProviderTimestamp(entry.timestamp, receivedAt);

  await Promise.allSettled([
    markOutboundSeen(mid, eventAt),
    recordRecoverySeen({
      instagramMessageId: mid,
      eventAt,
      receivedAt,
    }),
  ]);
}
