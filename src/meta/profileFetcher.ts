import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { describeGraphError } from "../services/eventLogger.js";
import { logger } from "../lib/logger.js";

/**
 * The account's TRUE follower total — the number Instagram shows on the profile.
 *
 * Why this exists: follower_demographics (demographicsFetcher.ts) reports only
 * Meta's top ~45 countries, so summing its buckets undercounts. Verified
 * 2026-07-26: demographics summed to 4,355 while this field returned 4,577 —
 * the 222 difference is followers in countries below Meta's reporting cutoff.
 *
 * Never throws: Home's entire follower panel hangs off the caller's route, so a
 * profile-fetch hiccup must degrade to null rather than blank the page.
 */
export interface ProfileTotals {
  followersTotal: number | null;
}

interface ProfileResponse {
  followers_count?: unknown;
}

export async function fetchProfileTotals(): Promise<ProfileTotals> {
  try {
    const { data } = await insightsGraph.get<ProfileResponse>(`/${env.IG_USER_ID}`, {
      params: { fields: "followers_count" },
    });
    const raw = data.followers_count;
    const followersTotal = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (followersTotal === null) {
      logger.warn(
        { errorCode: "followers_count_invalid", valueType: typeof raw },
        "followers_count missing or non-numeric",
      );
    }
    return { followersTotal };
  } catch (err) {
    logger.warn(describeGraphError(err), "fetchProfileTotals failed");
    return { followersTotal: null };
  }
}
