import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

// Private replies are valid for 7 days after the comment; the queue retries
// within that window.
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// First retry waits a few minutes (let the burst that caused the rate-limit pass).
const FIRST_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Remember a gate private reply that failed (rate limit / 2534025) so the worker
 * can retry it across the 7-day window. Non-throwing: enqueue failures must never
 * break comment handling.
 *
 * `commentAt` defaults to now (live path); the late-keyword backfill passes the
 * ORIGINAL comment timestamp so the worker's 7-day window math stays honest to
 * Meta's private-reply rule.
 */
export async function enqueueGate(args: {
  conversationId: string;
  igUserId: string;
  commentId: string;
  gateMessage: string;
  mediaId?: string | null;
  lastError?: string;
  initialErrorCategory?: string | null;
  commentAt?: Date;
}): Promise<void> {
  try {
    const now = Date.now();
    const isUncertain =
      args.initialErrorCategory === "transport_uncertain" ||
      args.initialErrorCategory === "uncertain";
    await prisma.gateQueue.create({
      data: {
        conversationId: args.conversationId,
        igUserId: args.igUserId,
        commentId: args.commentId,
        mediaId: args.mediaId ?? null,
        gateMessage: args.gateMessage,
        status: isUncertain ? "send_uncertain" : "pending",
        attempts: 0,
        lastError: args.lastError ?? null,
        commentAt: args.commentAt ?? new Date(now),
        nextAttemptAt: new Date(now + FIRST_RETRY_DELAY_MS),
      },
    });
  } catch {
    logger.error(
      { errorCode: "gate_retry_enqueue_failed", commentId: args.commentId },
      "Failed to enqueue gate retry",
    );
  }
}
