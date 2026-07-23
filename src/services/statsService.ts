import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

// Fix #11 — funnel follower yield over the recent measurement window: of the
// non-follower recipients we've been able to re-check, how many now follow.
export interface FollowConversion {
  windowDays: number;
  deliveredToNonFollowers: number; // non-follower deliveries in the window
  rechecked: number; // of those recipients, how many the worker has measured
  converted: number; // rechecked recipients who now follow
  pending: number; // measured-eligible but not yet rechecked
  yieldPct: number | null; // converted / rechecked, null until we have data
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
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Follower-yield snapshot over the last FOLLOW_RECHECK_MAX_AGE_DAYS. Reads:
 * - deliveries to non-followers (sequence_completed, followerAtDelivery=false),
 * - how many of those conversations the worker has rechecked (followRecheckedAt),
 * - how many of those rechecks recorded a conversion (follow_recheck events).
 * Non-follower deliveries not yet due (< recheck delay) surface as `pending`.
 */
async function getFollowConversion(): Promise<FollowConversion> {
  const windowDays = env.FOLLOW_RECHECK_MAX_AGE_DAYS;
  const since = new Date(Date.now() - windowDays * DAY_MS);

  const [completedEvents, rechecked, recheckEvents] = await Promise.all([
    prisma.eventLog.findMany({
      where: { kind: "sequence_completed", createdAt: { gte: since } },
      select: { payload: true },
    }),
    prisma.conversation.count({
      where: { state: "completed", followRecheckedAt: { gte: since } },
    }),
    prisma.eventLog.findMany({
      where: { kind: "follow_recheck", createdAt: { gte: since } },
      select: { payload: true },
    }),
  ]);

  const deliveredToNonFollowers = completedEvents.filter(
    (e) => (e.payload as { followerAtDelivery?: boolean | null } | null)?.followerAtDelivery === false,
  ).length;
  const converted = recheckEvents.filter(
    (e) => (e.payload as { converted?: boolean } | null)?.converted === true,
  ).length;

  return {
    windowDays,
    deliveredToNonFollowers,
    rechecked,
    converted,
    pending: Math.max(deliveredToNonFollowers - rechecked, 0),
    yieldPct: rechecked > 0 ? Math.round((converted / rechecked) * 1000) / 10 : null,
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
  };
}
