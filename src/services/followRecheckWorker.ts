import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { resolveUsername, getIgUsers } from "./igUserService.js";
import { logEvent } from "./eventLogger.js";

// Fix #11 — funnel follower yield. The DM funnel's job is turning reach into
// followers, but nobody re-checked whether a non-follower actually followed
// AFTER receiving the guide. This worker re-reads follow status a few days post-
// delivery for the convertible pool and records the outcome, making the yield
// measurable. resolveUsername is the single Graph call + it refreshes
// ig_users.isFollower; the follow flag stays readable after the 24h messaging
// window closes (consent persists — verified against live data).

const PER_CALL_GAP_MS = 1500; // gentle spacing between Graph calls (mirrors other workers)
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One recheck tick. Fully non-throwing — a failure here must never crash the
 * server (mirrors runGateQueueTick). Finds completed conversations old enough
 * that the recipient had time to follow but not yet measured, re-reads follow
 * status once per convertible user, and logs a follow_recheck outcome.
 */
export async function runFollowRecheckTick(): Promise<void> {
  try {
    const now = Date.now();
    const dueBefore = new Date(now - env.FOLLOW_RECHECK_DELAY_DAYS * DAY_MS);
    const tooOld = new Date(now - env.FOLLOW_RECHECK_MAX_AGE_DAYS * DAY_MS);

    const due = await prisma.conversation.findMany({
      where: {
        state: "completed",
        followRecheckedAt: null,
        completedAt: { gte: tooOld, lte: dueBefore },
      },
      orderBy: { completedAt: "asc" },
      take: env.FOLLOW_RECHECK_BATCH,
      select: { id: true, igUserId: true },
    });
    if (due.length === 0) return;

    // Group due conversations by user so a user with several completions costs
    // at most one Graph call this tick.
    const convosByUser = new Map<string, string[]>();
    for (const c of due) {
      const list = convosByUser.get(c.igUserId) ?? [];
      list.push(c.id);
      convosByUser.set(c.igUserId, list);
    }

    // Users already known to follow need no API call — stamp them done cheaply.
    const users = await getIgUsers([...convosByUser.keys()]);

    let apiCalls = 0;
    let nowFollowing = 0;
    for (const [igUserId, convoIds] of convosByUser) {
      const cached = users[igUserId];
      let isFollowerNow: boolean | null;
      let apiCall: boolean;

      if (cached?.isFollower === true) {
        isFollowerNow = true;
        apiCall = false;
      } else {
        const profile = await resolveUsername(igUserId);
        isFollowerNow = profile.isFollower;
        apiCall = true;
        apiCalls++;
      }

      if (isFollowerNow === true) nowFollowing++;

      await prisma.conversation.updateMany({
        where: { id: { in: convoIds } },
        data: { followRecheckedAt: new Date() },
      });
      // Record the raw fact (isFollowerNow). Whether it counts as a funnel
      // conversion is decided at the stats layer, which scopes to the
      // non-follower pool — a user already following at delivery isn't one.
      await logEvent("follow_recheck", {
        igUserId,
        conversationIds: convoIds,
        isFollowerNow,
        apiCall,
      });

      if (apiCall) await sleep(PER_CALL_GAP_MS);
    }

    logger.info(
      { users: convosByUser.size, apiCalls, nowFollowing },
      "Follow-recheck tick complete",
    );
  } catch (err) {
    logger.error({ err }, "followRecheckWorker tick failed");
  }
}
