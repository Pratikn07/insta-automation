import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { normalizeKeyword, textContainsKeyword } from "./keywordService.js";
import { openConversationIn } from "./conversationService.js";
import { resolveJourneyIntent } from "./journeyIntentService.js";
import { enqueueGate, PRIVATE_REPLY_WINDOW_MS } from "./gateQueueService.js";
import { logEvent } from "./eventLogger.js";

// Keywords are often configured AFTER the reel is already live (PLAY was 12 days
// late), so the reel's earliest — and hottest — commenters get no gate. Meta's
// private-reply window is 7 days from the comment, which makes the recent slice
// recoverable: scan received comments, open conversations, and hand delivery to
// the existing paced gate-queue worker.

interface CandidateComment {
  commentId: string;
  fromId: string;
  mediaId: string | null;
  createdAt: Date;
}

/**
 * Enqueue gates for every user who commented this keyword within the last 7 days
 * but never got a conversation (commented before the keyword existed, or their
 * phrasing missed first-token matching). Idempotent: users with ANY conversation
 * for this keyword are skipped, so re-runs and route-triggered runs are safe.
 * Non-throwing; returns the number of gates enqueued.
 */
export async function backfillKeyword(
  keywordId: string,
  options: { excludeCommentIds?: string[] } = {},
): Promise<number> {
  try {
    const kw = await prisma.keyword.findUnique({ where: { id: keywordId } });
    if (!kw || !kw.active) return 0;
    const norm = normalizeKeyword(kw.keyword);

    const windowStart = new Date(Date.now() - PRIVATE_REPLY_WINDOW_MS);
    const rows = await prisma.eventLog.findMany({
      where: { kind: "comment_received", createdAt: { gte: windowStart } },
      orderBy: { createdAt: "asc" },
      select: { payload: true, createdAt: true },
    });
    const excludedCommentIds = new Set(options.excludeCommentIds ?? []);

    // Latest matching comment per user (asc order → Map.set keeps the newest).
    const byUser = new Map<string, CandidateComment>();
    for (const r of rows) {
      const p = r.payload as {
        commentId?: string;
        fromId?: string;
        text?: string;
        mediaId?: string | null;
      };
      if (!p.commentId || !p.fromId || !p.text) continue;
      if (excludedCommentIds.has(p.commentId)) continue;
      if (p.fromId === env.IG_USER_ID) continue; // own replies (bot or manual)
      if (kw.mediaId && p.mediaId !== kw.mediaId) continue; // respect reel scope
      if (!textContainsKeyword(p.text, norm)) continue;
      byUser.set(p.fromId, {
        commentId: p.commentId,
        fromId: p.fromId,
        mediaId: p.mediaId ?? null,
        createdAt: r.createdAt,
      });
    }
    if (byUser.size === 0) return 0;

    // Anyone with a conversation for this keyword (any state) was already
    // handled by the live path — or a previous backfill run.
    const existing = await prisma.conversation.findMany({
      where: { keywordId: kw.id, igUserId: { in: [...byUser.keys()] } },
      select: { igUserId: true },
    });
    for (const e of existing) byUser.delete(e.igUserId);

    let enqueued = 0;
    for (const c of byUser.values()) {
      // The conversation filter above already removed anyone the live path
      // handled, so these should all be genuinely new. Going through the resolver
      // anyway means the backfill records its triggers like every other entry
      // point, and cannot enqueue a second gate if a race or a re-run puts someone
      // back in this list — the guard is the same one the comment path uses.
      const journey = await resolveJourneyIntent(
        {
          igUserId: c.fromId,
          keywordId: kw.id,
          commentId: c.commentId,
          mediaId: c.mediaId,
          // The original comment's time, not now: this gate is being sent late and
          // the 7-day private-reply window is measured from the comment.
          receivedAt: c.createdAt,
          triggerKind: "comment",
        },
        (tx) => openConversationIn(tx, c.fromId, kw.id),
      );

      if (!journey.maySendGate) {
        await logEvent("backfill_skipped_existing_journey", {
          conversationId: journey.conversationId,
          keyword: kw.keyword,
          commentId: c.commentId,
          fromId: c.fromId,
          disposition: journey.disposition,
        });
        continue;
      }

      const conversationId = journey.conversationId!;
      await enqueueGate({
        conversationId,
        igUserId: c.fromId,
        commentId: c.commentId,
        mediaId: c.mediaId,
        gateMessage: kw.gateMessage,
        commentAt: c.createdAt,
      });
      await logEvent("backfill_enqueued", {
        conversationId,
        keyword: kw.keyword,
        commentId: c.commentId,
        fromId: c.fromId,
        commentAt: c.createdAt.toISOString(),
      });
      enqueued++;
    }

    if (enqueued > 0) {
      logger.info({ keyword: kw.keyword, enqueued }, "Backfilled gates for late keyword");
    }
    return enqueued;
  } catch {
    logger.error({ errorCode: "keyword_backfill_failed", keywordId }, "keyword backfill failed");
    return 0;
  }
}
