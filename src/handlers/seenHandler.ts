import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { markOutboundSeen } from "../services/dmThreadService.js";
import { recordRecoverySeen } from "../services/dmRecoveryService.js";

function parseEventTime(rawTimestamp: number | undefined): Date {
  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return new Date(rawTimestamp);
  }
  return new Date();
}

export async function handleSeen(entry: MessagingEntry): Promise<void> {
  const mid = entry.read?.mid;
  if (!mid) {
    logger.debug({ senderId: entry.sender?.id }, "Seen webhook entry missing read.mid");
    return;
  }

  const eventAt = parseEventTime(entry.timestamp);
  const receivedAt = new Date();

  await Promise.allSettled([
    markOutboundSeen(mid, eventAt),
    recordRecoverySeen({
      instagramMessageId: mid,
      eventAt,
      receivedAt,
    }),
  ]);
}
