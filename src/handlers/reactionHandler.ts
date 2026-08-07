import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { recordRecoveryReaction } from "../services/dmRecoveryService.js";

function parseEventTime(rawTimestamp: number | undefined): Date {
  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) && rawTimestamp > 0) {
    return new Date(rawTimestamp);
  }
  return new Date();
}

export async function handleReaction(entry: MessagingEntry): Promise<void> {
  const reaction = entry.reaction;
  if (!reaction || !reaction.mid) {
    logger.debug({ senderId: entry.sender?.id }, "Reaction webhook entry missing mid");
    return;
  }

  if (reaction.action === "unreact") {
    logger.info(
      { mid: reaction.mid, senderId: entry.sender?.id },
      "Received unreact event — preserving existing suppression",
    );
    return;
  }

  const eventAt = parseEventTime(entry.timestamp);
  const receivedAt = new Date();

  await recordRecoveryReaction({
    instagramMessageId: reaction.mid,
    eventAt,
    receivedAt,
  });
}
