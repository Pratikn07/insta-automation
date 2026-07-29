import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { readTokenHealth } from "../meta/tokenStore.js";
import {
  FOLLOW_THROUGH_MIN_DAYS,
  summarizeRetention,
} from "./followThroughCore.js";
import type { TokenHealth } from "../meta/tokenStoreCore.js";

// Fix #11 — funnel follower yield over the recent measurement window: of the
// non-follower recipients we've been able to re-check, how many now follow.
export interface FollowConversion {
  windowDays: number;
  deliveredToNonFollowers: number; // non-follower deliveries in the window
  rechecked: number; // of those recipients, how many the worker has measured
  converted: number; // rechecked recipients who now follow
  pending: number; // measured-eligible but not yet rechecked
  yieldPct: number | null; // converted / rechecked, null until we have data
  // Follow-THROUGH: of the converts, how many were still following when
  // re-measured ~3 weeks later. This is what keeps yieldPct honest — a single
  // reading taken days after delivery cannot tell a real follower from someone
  // who unlocked a freebie and left.
  followThroughDays: number;
  followThroughChecked: number;
  stillFollowing: number;
  unfollowed: number;
  retentionPct: number | null; // null below MIN_RETENTION_SAMPLE
}

export interface DashboardStats {
  activeKeywords: number;
  totalKeywords: number;
  dmsSentToday: number;
  conversationsAwaiting: number;
  completedToday: number;
  lastError: { kind: string; createdAt: Date; payload: unknown } | null;
  gateQueuePending: number;
  gateQueueExhausted: number;
  followConversion: FollowConversion;
  // Instagram token countdown. The refresh worker should keep this permanently
  // healthy; a warning here means the worker itself has stopped, which is the
  // failure that caused the 2026-07-26 outage (nothing was watching).
  // null only before the ig_token row is first seeded.
  tokenHealth: TokenHealth | null;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Follower-yield snapshot over the last FOLLOW_RECHECK_MAX_AGE_DAYS, scoped to
 * the non-follower pool so already-followers can't inflate the rate:
 * - pool = distinct users who received a guide while NOT a follower
 *   (sequence_completed, followerAtDelivery=false);
 * - rechecked = pool users whose follow status the worker has since refreshed;
 * - converted = rechecked pool users who now follow (current ig_users.isFollower);
 * - pending = pool users not yet rechecked.
 * Conversion is a lower bound (single recheck) and correlational, not causal.
 */
async function getFollowConversion(): Promise<FollowConversion> {
  const windowDays = env.FOLLOW_RECHECK_MAX_AGE_DAYS;

  const [row] = await prisma.$queryRaw<
    { delivered: bigint; rechecked: bigint; converted: bigint }[]
  >`
    WITH pool AS (
      SELECT DISTINCT c.ig_user_id
      FROM event_log e
      JOIN conversations c ON c.id = (e.payload->>'conversationId')::uuid
      WHERE e.kind = 'sequence_completed'
        AND (e.payload->>'followerAtDelivery')::boolean IS FALSE
        AND e.created_at >= now() - (${windowDays} || ' days')::interval
    ),
    rechecked_users AS (
      SELECT DISTINCT payload->>'igUserId' AS ig_user_id
      FROM event_log WHERE kind = 'follow_recheck'
    )
    SELECT
      COUNT(*) AS delivered,
      COUNT(*) FILTER (WHERE ru.ig_user_id IS NOT NULL) AS rechecked,
      COUNT(*) FILTER (WHERE ru.ig_user_id IS NOT NULL AND u.is_follower IS TRUE) AS converted
    FROM pool p
    LEFT JOIN rechecked_users ru ON ru.ig_user_id = p.ig_user_id
    LEFT JOIN ig_users u ON u.id = p.ig_user_id
  `;

  // Follow-through is a separate query: it counts USERS with a second reading,
  // not conversations, and must not disturb the yield numbers above.
  const [ft] = await prisma.$queryRaw<{ checked: bigint; still_following: bigint }[]>`
    SELECT
      COUNT(DISTINCT c.ig_user_id) AS checked,
      COUNT(DISTINCT c.ig_user_id) FILTER (WHERE c.follow_through_is_follower IS TRUE)
        AS still_following
    FROM event_log e
    JOIN conversations c ON c.id = (e.payload->>'conversationId')::uuid
    WHERE e.kind = 'sequence_completed'
      AND (e.payload->>'followerAtDelivery')::boolean IS FALSE
      AND c.follow_through_at IS NOT NULL
  `;
  const followThroughChecked = Number(ft?.checked ?? 0);
  const stillFollowing = Number(ft?.still_following ?? 0);
  const retention = summarizeRetention(followThroughChecked, stillFollowing);

  const deliveredToNonFollowers = Number(row?.delivered ?? 0);
  const rechecked = Number(row?.rechecked ?? 0);
  const converted = Number(row?.converted ?? 0);

  return {
    windowDays,
    deliveredToNonFollowers,
    rechecked,
    converted,
    pending: Math.max(deliveredToNonFollowers - rechecked, 0),
    yieldPct: rechecked > 0 ? Math.round((converted / rechecked) * 1000) / 10 : null,
    followThroughDays: FOLLOW_THROUGH_MIN_DAYS,
    followThroughChecked,
    stillFollowing,
    unfollowed: retention.unfollowed,
    retentionPct: retention.retentionPct,
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const today = startOfTodayUtc();

  const [
    activeKeywords,
    totalKeywords,
    dmsSentToday,
    awaiting,
    completedToday,
    lastError,
    gateQueuePending,
    gateQueueExhausted,
    followConversion,
    tokenHealth,
  ] = await Promise.all([
    prisma.keyword.count({ where: { active: true } }),
    prisma.keyword.count(),
    prisma.eventLog.count({
      where: { kind: "dm_sent", createdAt: { gte: today } },
    }),
    prisma.conversation.count({ where: { state: "awaiting_done" } }),
    prisma.conversation.count({
      where: { state: "completed", completedAt: { gte: today } },
    }),
    prisma.eventLog.findFirst({
      where: { kind: "error" },
      orderBy: { createdAt: "desc" },
      select: { kind: true, createdAt: true, payload: true },
    }),
    prisma.gateQueue.count({ where: { status: "pending" } }),
    prisma.gateQueue.count({ where: { status: "exhausted" } }),
    getFollowConversion(),
    // Non-fatal: a stats page must still render if this lookup fails.
    readTokenHealth().catch(() => null),
  ]);

  return {
    activeKeywords,
    totalKeywords,
    dmsSentToday,
    conversationsAwaiting: awaiting,
    completedToday,
    lastError,
    gateQueuePending,
    gateQueueExhausted,
    followConversion,
    tokenHealth,
  };
}
