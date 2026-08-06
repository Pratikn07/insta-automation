import { prisma } from "../lib/prisma.js";

const STALE_SENDING_MS = 15 * 60 * 1000;

/**
 * Reconcile claims that may have crossed the Instagram boundary before a crash.
 * This worker only closes database state; it never retries or sends a message.
 */
export async function runReplyDraftRecoveryTick(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
  const result = await prisma.replyDraft.updateMany({
    where: { status: "sending", updatedAt: { lte: cutoff } },
    data: {
      status: "send_uncertain",
      errorCode: "send_state_recovered_after_restart",
      failedAt: now,
    },
  });
  return result.count;
}
