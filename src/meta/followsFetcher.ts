import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { describeGraphError } from "../services/eventLogger.js";
import { analyticsDayBounds } from "../services/analyticsDay.js";
import { logger } from "../lib/logger.js";

// Meta's own daily follower ledger: `follows_and_unfollows`, documented as "the
// number of accounts that followed you and the number of accounts that
// unfollowed you or left Instagram in the selected time period".
//
// This is the ONLY source that separates the two sides. followers_count gives an
// exact NET figure, so a day that gained 400 and lost 380 is indistinguishable
// from one that gained 20 and lost nothing — very different days for the same
// bar. follower_demographics cannot help either: it is a cumulative vector.
//
// Two things make this metric worth handling defensively rather than trusting:
//
//   - Meta returns an EMPTY DATA SET rather than 0 when a figure is unavailable,
//     which is documented behaviour, and this metric in particular went silent
//     for months in 2024 (Meta bug 812843054241651) while still returning 200.
//   - The docs describe `follow_type` as FOLLOWER / NON_FOLLOWER / UNKNOWN,
//     which is the spelling the `reach` breakdown uses. On this metric the field
//     reports the follow/unfollow split instead. Rather than pick a side, the
//     parser below reads whatever Meta spells and REFUSES the response unless it
//     can identify both halves — a FOLLOWER/NON_FOLLOWER answer is not a churn
//     split and must not be rendered as one.
//
// Everything here degrades to null. Churn is an enrichment on top of the chart;
// it must never be able to take the follower panel down with it.

export interface FollowerChurnDay {
  follows: number;
  unfollows: number;
}

interface InsightsResponse {
  data?: Array<{
    name?: string;
    total_value?: {
      value?: number;
      breakdowns?: Array<{
        dimension_keys?: string[];
        results?: Array<{ dimension_values?: string[]; value?: number }>;
      }>;
    };
  }>;
}

/**
 * Pull the follow/unfollow split out of a `follows_and_unfollows` payload.
 *
 * Exported for its own tests: the response shape is the part of this feature we
 * cannot verify from the documentation, so it is the part that has to be pinned
 * down by example.
 *
 * Returns null unless BOTH sides were identified. Half a ledger would render as
 * "0 unfollows", which is a much worse lie than showing nothing.
 */
export function parseFollowerChurn(body: InsightsResponse): FollowerChurnDay | null {
  const datum =
    body.data?.find((entry) => entry.name === "follows_and_unfollows") ?? body.data?.[0];
  const breakdowns = datum?.total_value?.breakdowns ?? [];

  let follows: number | null = null;
  let unfollows: number | null = null;

  for (const breakdown of breakdowns) {
    for (const result of breakdown.results ?? []) {
      const label = (result.dimension_values ?? []).join("/").toUpperCase();
      const value = result.value ?? 0;
      // UNFOLLOW is tested first on purpose: "UNFOLLOWS".includes("FOLLOW") is
      // true, so the looser test would swallow both sides into `follows`.
      if (label.includes("UNFOLLOW")) unfollows = (unfollows ?? 0) + value;
      else if (label.includes("FOLLOW")) follows = (follows ?? 0) + value;
    }
  }

  if (follows === null || unfollows === null) return null;
  return { follows, unfollows };
}

/**
 * One Pacific analytics day of follows and unfollows.
 *
 * The window is the account's own analytics day, converted to the Unix bounds
 * the Graph API wants, so a churn figure lines up with the bar it annotates.
 * Meta buckets account insights by the ACCOUNT's timezone; this account's
 * analytics calendar is already Pacific, so the two agree — probe step 5 in
 * scripts/probe-follower-daily-metrics.mjs is what confirms that against the
 * live account rather than by assumption.
 */
export async function fetchFollowerChurn(day: string): Promise<FollowerChurnDay | null> {
  const { start, endExclusive } = analyticsDayBounds(day);
  try {
    const { data } = await insightsGraph.get<InsightsResponse>(`/${env.IG_USER_ID}/insights`, {
      params: {
        metric: "follows_and_unfollows",
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: Math.floor(start.getTime() / 1000),
        until: Math.floor(endExclusive.getTime() / 1000),
      },
    });
    return parseFollowerChurn(data);
  } catch (err) {
    logger.warn({ ...describeGraphError(err), day }, "fetchFollowerChurn failed");
    return null;
  }
}
