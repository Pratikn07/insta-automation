import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { fetchFollowerChurn } from "../meta/followsFetcher.js";
import { dayKeyToSqlDate, shiftDayKey, sqlDateToDayKey, toAnalyticsDayKey } from "./analyticsDay.js";

// Collects Meta's follows/unfollows ledger day by day.
//
// `follows_and_unfollows` supports total_value only — there is no time_series
// variant — so a daily series has to be assembled one since/until window at a
// time. That is fine: they are cheap account-level calls, and unlike
// followers_count this metric answers historical windows, so the collector can
// fill in behind itself instead of only capturing forward.

/** How far back to assemble the ledger. Matches the chart's own lookback. */
const LOOKBACK_DAYS = 90;
/**
 * The trailing days re-fetched on every tick regardless of what is stored.
 *
 * Meta's figures may be delayed up to 48 hours, so today and yesterday are still
 * moving; a third day of overlap covers a tick that lands either side of a
 * boundary. Re-requesting them is also what lets an `unavailable` recent day
 * recover once Meta catches up.
 */
const REFRESH_DAYS = 3;
/**
 * Ceiling on Graph calls per tick. A cold start has 90 days to fill; doing that
 * in one burst would be the largest thing this app has ever asked Meta for in a
 * single pass, for data that is in no hurry. At 20/tick and a 6h interval the
 * backfill completes in about a day and then costs REFRESH_DAYS calls forever.
 */
const MAX_FETCHES_PER_TICK = 20;
/** Gentle spacing, same spirit as the reel loop's PER_REEL_GAP_MS. */
const PER_DAY_GAP_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChurnCollectionResult {
  ok: number;
  unavailable: number;
  /** Stored figures a transient failure would have erased, and did not. */
  kept: number;
  /** Days in the lookback still awaiting a first answer, so a cold-start backfill is visible in the logs. */
  remaining: number;
}

/**
 * Decide which days to request, newest first.
 *
 * Exported for its own tests: the scheduling rule (always refresh the settling
 * window, fill gaps behind it, never re-request a settled `unavailable` day) is
 * the whole of this module's behaviour, and it is not observable from the
 * outside once the Graph calls are mocked away.
 */
export function daysToFetch(
  today: string,
  known: Map<string, string>,
  limit = MAX_FETCHES_PER_TICK,
): string[] {
  const oldest = shiftDayKey(today, -(LOOKBACK_DAYS - 1));
  const refreshFrom = shiftDayKey(today, -(REFRESH_DAYS - 1));
  const targets: string[] = [];

  for (let day = today; day >= oldest; day = shiftDayKey(day, -1)) {
    // Inside the settling window: always ask again, stored or not.
    if (day >= refreshFrom) {
      targets.push(day);
      continue;
    }
    // Behind it: only days we have never successfully filled. An older
    // `unavailable` row is Meta's settled answer and is left alone — retrying it
    // every tick would spend the whole budget on days that will never arrive.
    if (!known.has(day)) targets.push(day);
  }
  return targets.slice(0, limit);
}

export interface ChurnCollectionOptions {
  now?: Date;
  /** Graph calls this pass may make. Lowered in tests so the paced loop stays fast. */
  limit?: number;
  /** Spacing between calls. Zero in tests, for the same reason. */
  gapMs?: number;
}

/**
 * One churn collection pass. Non-throwing, like every other snapshot step: churn
 * is an enrichment on the follower panel and must never be able to take it down.
 */
export async function collectFollowerChurn(
  options: ChurnCollectionOptions = {},
): Promise<ChurnCollectionResult> {
  const {
    now = new Date(),
    limit = MAX_FETCHES_PER_TICK,
    gapMs = PER_DAY_GAP_MS,
  } = options;
  const today = toAnalyticsDayKey(now);
  const oldest = shiftDayKey(today, -(LOOKBACK_DAYS - 1));

  const existing = await prisma.followerChurnDaySnapshot.findMany({
    where: { day: { gte: dayKeyToSqlDate(oldest) } },
    select: { day: true, status: true },
  });
  const known = new Map(existing.map((row) => [sqlDateToDayKey(row.day), row.status]));

  const targets = daysToFetch(today, known, limit);
  let ok = 0;
  let unavailable = 0;
  let kept = 0;

  for (const [index, day] of targets.entries()) {
    const churn = await fetchFollowerChurn(day);
    const data = churn
      ? { follows: churn.follows, unfollows: churn.unfollows, status: "ok" }
      : { follows: null, unfollows: null, status: "unavailable" };

    // Never downgrade a stored 'ok' to 'unavailable'. A transient failure inside
    // the settling window would otherwise erase a figure we already have, and
    // the chart would lose churn it had been showing all week.
    if (data.status === "unavailable" && known.get(day) === "ok") {
      kept++;
    } else {
      await prisma.followerChurnDaySnapshot.upsert({
        where: { day: dayKeyToSqlDate(day) },
        create: { day: dayKeyToSqlDate(day), ...data },
        update: data,
      });
      if (data.status === "ok") ok++;
      else unavailable++;
    }

    if (gapMs > 0 && index < targets.length - 1) await sleep(gapMs);
  }

  // Every target now carries a row (an 'unavailable' one counts as answered), so
  // what is left is the part of the lookback the backfill has not reached yet.
  const answered = new Set([...known.keys(), ...targets]);
  const remaining = Math.max(LOOKBACK_DAYS - answered.size, 0);

  logger.info(
    { ok, unavailable, kept, requested: targets.length, remaining },
    "Follower churn collected",
  );
  return { ok, unavailable, kept, remaining };
}
