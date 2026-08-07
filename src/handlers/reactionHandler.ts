import type { MessagingEntry } from "../types/meta.js";
import { logger } from "../lib/logger.js";
import { parseProviderTimestamp } from "../lib/providerTime.js";
import { recordRecoveryReaction } from "../services/dmRecoveryService.js";

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

  const receivedAt = new Date();
  const eventAt = parseProviderTimestamp(entry.timestamp, receivedAt);

  await recordRecoveryReaction({
    instagramMessageId: reaction.mid,
    eventAt,
    receivedAt,
  });
}
