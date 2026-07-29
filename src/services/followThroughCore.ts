// Pure core for follow-THROUGH: do guide recipients who followed actually stay?
// (No prisma/env imports, no Date.now() — time is passed in.)
//
// WHY THIS EXISTS. The follow-yield tile says "23 of 97 non-followers followed
// after getting their guide" (23.7%). That is a single measurement taken ~3 days
// post-delivery and never revisited, so it cannot distinguish a real new follower
// from someone who followed to unlock a freebie and left a week later. Asked
// directly whether recipients unfollow, the honest answer was "the app cannot
// tell" — only 19 of 960 users had ever been checked twice, and Meta reports
// follower geography as NET change, so account-level churn is invisible too.
//
// This adds the second measurement. It deliberately does NOT claim causation:
// it reports whether the people counted as conversions are still following
// later, which is the minimum needed before trusting 23.7% as a real number.

/**
 * Days after completion before a follow-through reading is meaningful.
 *
 * 21 days: long enough that a freebie-grab-and-leave has had time to show up,
 * short enough that ~59 users already qualify today (at 30 days only 453
 * conversations qualify at all and the converted subset gets thin).
 */
export const FOLLOW_THROUGH_MIN_DAYS = 21;

/**
 * Below this many checked users, report null instead of a percentage. With 3
 * users, a single unfollow reads as "33% churn" — a number that invites a
 * decision the sample cannot support.
 */
export const MIN_RETENTION_SAMPLE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionSummary {
  /** Share of measured converts still following, null below MIN_RETENTION_SAMPLE. */
  retentionPct: number | null;
  unfollowed: number;
}

/**
 * Whether this conversation needs a follow-through reading now.
 *
 * `convertedAtFirstRecheck` gates the work to people who actually followed —
 * someone who never followed has nothing to un-follow, so re-checking them would
 * spend Graph calls to learn nothing.
 */
export function isFollowThroughDue(
  completedAt: Date | null,
  convertedAtFirstRecheck: boolean | null,
  lastFollowThroughAt: Date | null,
  nowMs: number,
): boolean {
  if (!completedAt) return false; // legacy row, no clock to measure from
  if (convertedAtFirstRecheck !== true) return false;
  if (lastFollowThroughAt) return false; // already answered

  const ageMs = nowMs - completedAt.getTime();
  return ageMs > FOLLOW_THROUGH_MIN_DAYS * DAY_MS;
}

/**
 * Retention across the measured converts.
 *
 * `checked` is how many converts got a follow-through reading — NOT the total
 * number of converts. Reporting against converts would understate retention
 * while the worker is still catching up.
 */
export function summarizeRetention(checked: number, stillFollowing: number): RetentionSummary {
  // Clamp: stillFollowing should never exceed checked, but a race between two
  // queries must not surface as "-1 unfollowed".
  const unfollowed = Math.max(checked - stillFollowing, 0);
  const retentionPct =
    checked >= MIN_RETENTION_SAMPLE
      ? Math.round((stillFollowing / checked) * 1000) / 10
      : null;
  return { retentionPct, unfollowed };
}
