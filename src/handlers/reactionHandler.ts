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

  // Allowlist rather than a denylist: an unknown or missing action is not
  // evidence that anyone engaged, and treating it as such would suppress a
  // reminder — or, mid-lease, fail to. `unreact` is deliberately a no-op: taking
  // an emoji back does not un-prove that the DM was opened.
  if (reaction.action !== "react") {
    logger.info(
      { mid: reaction.mid, action: reaction.action ?? null, senderId: entry.sender?.id },
      "Reaction event is not a positive react — no engagement recorded",
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
