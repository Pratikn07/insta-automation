import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Claim a comment webhook so it is acted on exactly once.
 *
 * Meta delivers webhooks at least once. `handleComment` is not otherwise
 * idempotent — a repeat opens another conversation, posts another public reply,
 * and sends the same person a second gate DM.
 *
 * The claim is an insert, not a read followed by a write: the primary key
 * decides the winner, so two deliveries arriving together cannot both pass. A
 * check-then-act guard would leave exactly the window this exists to close.
 *
 * Returns true when the caller owns the comment and should proceed.
 */
export async function claimComment(commentId: string, igUserId: string): Promise<boolean> {
  try {
    await prisma.processedComment.create({ data: { commentId, igUserId } });
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : null;

    if (code === "P2002") {
      logger.debug({ commentId }, "Comment already handled — duplicate webhook delivery");
      return false;
    }

    // Any other failure means we cannot prove this comment is unclaimed.
    // Declining is the safe direction: a dropped comment is recoverable — the
    // keyword backfill reconstructs pending gates from comment_received events
    // for users with no conversation — whereas a duplicate DM is not.
    logger.error(
      { errorCode: "comment_claim_failed", commentId },
      "Could not claim comment; skipping to avoid a duplicate send",
    );
    return false;
  }
}
