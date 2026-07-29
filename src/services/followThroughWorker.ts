import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { resolveUsername } from "./igUserService.js";
import { logEvent } from "./eventLogger.js";
import { FOLLOW_THROUGH_MIN_DAYS } from "./followThroughCore.js";

// Second follow reading for guide recipients who converted: are they STILL
// following ~3 weeks later, or did they take the freebie and leave?
//
// CRITICAL DIFFERENCE FROM followRecheckWorker. That worker skips the Graph call
// when ig_users already says isFollower = true ("users already known to follow
// need no API call"). Reusing that shortcut here would defeat the entire feature:
// every convert is cached as a follower BY DEFINITION — that is why they were
// counted — so the cache would answer "still following" for everyone and the
// metric would report ~100% retention no matter what actually happened. This
// worker therefore ALWAYS calls resolveUsername.
//
// Cost is small: ~59 users qualify today, then a trickle as new conversions age
// past the window. At 1.5s spacing against an account currently using 0% of its
// rate limit, this is noise.

const PER_CALL_GAP_MS = 1500; // matches followRecheckWorker's pacing
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One follow-through tick. Fully non-throwing — a failure here must never crash
 * the server (mirrors runFollowRecheckTick).
 *
 * Scope: conversations that completed at least FOLLOW_THROUGH_MIN_DAYS ago, were
 * already rechecked once, have no follow-through reading yet, and whose user was
 * counted as a CONVERT (non-follower at delivery who later followed). Anyone who
 * never followed is skipped — there is nothing to un-follow.
 */
export async function runFollowThroughTick(): Promise<void> {
  try {
    const dueBefore = new Date(Date.now() - FOLLOW_THROUGH_MIN_DAYS * DAY_MS);

    // The convert pool, resolved in SQL for the same reason getFollowConversion
    // does it there: "was a non-follower at delivery" lives in event_log payloads,
    // not on the conversation row.
    const due = await prisma.$queryRaw<{ ig_user_id: string }[]>`
      SELECT DISTINCT c.ig_user_id
      FROM event_log e
      JOIN conversations c ON c.id = (e.payload->>'conversationId')::uuid
      JOIN ig_users u ON u.id = c.ig_user_id
      WHERE e.kind = 'sequence_completed'
        AND (e.payload->>'followerAtDelivery')::boolean IS FALSE
        AND c.follow_rechecked_at IS NOT NULL
        AND c.follow_through_at IS NULL
        AND c.completed_at <= ${dueBefore}
        AND u.is_follower IS TRUE
      ORDER BY c.ig_user_id
      LIMIT ${env.FOLLOW_RECHECK_BATCH}
    `;
    if (due.length === 0) return;

    let stillFollowing = 0;
    let unfollowed = 0;

    for (const { ig_user_id: igUserId } of due) {
      // ALWAYS a fresh call — see the note at the top of this file.
      const profile = await resolveUsername(igUserId);
      const isFollowerNow = profile.isFollower;

      if (isFollowerNow === true) stillFollowing++;
      else if (isFollowerNow === false) unfollowed++;

      // Stamp every conversation for this user so the batch cannot loop on them,
      // even when the reading came back null (unresolvable profile).
      await prisma.conversation.updateMany({
        where: { igUserId, followRecheckedAt: { not: null }, followThroughAt: null },
        data: { followThroughAt: new Date(), followThroughIsFollower: isFollowerNow },
      });

      await logEvent("follow_through", {
        igUserId,
        isFollowerNow,
        daysAfter: FOLLOW_THROUGH_MIN_DAYS,
        unfollowed: isFollowerNow === false,
      });

      await sleep(PER_CALL_GAP_MS);
    }

    logger.info(
      { users: due.length, stillFollowing, unfollowed },
      "Follow-through tick complete",
    );
  } catch (err) {
    logger.error({ err }, "followThroughWorker tick failed");
  }
}
