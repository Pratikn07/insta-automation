import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { describeGraphError } from "../services/eventLogger.js";
import { logger } from "../lib/logger.js";

// Account-level audience geography. Meta exposes geo ONLY at the account level
// (never per-reel), in three funnel stages. Ported from the proven read-only
// probe at scripts/probe-geo-demographics.mjs.
export type GeoStage = "follower" | "engaged" | "reached";

const STAGE_METRIC: Record<GeoStage, string> = {
  follower: "follower_demographics",
  engaged: "engaged_audience_demographics",
  reached: "reached_audience_demographics",
};

// Meta accepts ONLY these two timeframes for demographics (probed: last_30_days
// returns empty; timeframe IS honored here, unlike the reach metric where it's
// inert). 90d = stable baseline; 14d = moving "who are my RECENT reels pulling"
// thermometer — the two diverge (e.g. engaged 38.7% US @90d vs 27.6% @14d).
export type GeoTimeframe = "last_14_days" | "last_90_days";

// follower_demographics is lifetime-only and ignores timeframe, so windowing
// applies to engaged + reached only.
const WINDOWABLE_STAGES: GeoStage[] = ["engaged", "reached"];

export interface CountrySplit {
  stage: GeoStage;
  timeframe: GeoTimeframe;
  counts: Record<string, number>; // ISO country code -> count
  totalCounted: number;
  usPct: number | null;
  inPct: number | null;
}

// The Graph response nests results under total_value.breakdowns[].results[],
// where dimension_keys names the breakdown columns (we want "country").
interface DemographicsResponse {
  data?: Array<{
    total_value?: {
      breakdowns?: Array<{
        dimension_keys?: string[];
        results?: Array<{ dimension_values?: string[]; value?: number }>;
      }>;
    };
  }>;
}

function extractCountryCounts(body: DemographicsResponse): Record<string, number> {
  const breakdowns = body.data?.[0]?.total_value?.breakdowns ?? [];
  const counts: Record<string, number> = {};
  for (const bd of breakdowns) {
    const idx = bd.dimension_keys?.indexOf("country") ?? -1;
    if (idx === -1) continue;
    for (const r of bd.results ?? []) {
      const country = r.dimension_values?.[idx];
      if (!country) continue;
      counts[country] = (counts[country] ?? 0) + (r.value ?? 0);
    }
  }
  return counts;
}

function pct(counts: Record<string, number>, code: string, total: number): number | null {
  if (total === 0) return null;
  return Math.round(((counts[code] ?? 0) / total) * 1000) / 10; // one decimal
}

/**
 * Fetch the country split for one funnel stage. Resilient: a single stage failing
 * (unsupported metric, low volume) returns null rather than throwing, so the
 * caller can still record the stages that did succeed.
 */
export async function fetchCountrySplit(
  stage: GeoStage,
  timeframe: GeoTimeframe = "last_90_days",
): Promise<CountrySplit | null> {
  try {
    const { data } = await insightsGraph.get<DemographicsResponse>(`/${env.IG_USER_ID}/insights`, {
      params: {
        metric: STAGE_METRIC[stage],
        period: "lifetime",
        timeframe,
        breakdown: "country",
        metric_type: "total_value",
      },
    });
    const counts = extractCountryCounts(data);
    const totalCounted = Object.values(counts).reduce((s, v) => s + v, 0);
    return {
      stage,
      timeframe,
      counts,
      totalCounted,
      usPct: pct(counts, "US", totalCounted),
      inPct: pct(counts, "IN", totalCounted),
    };
  } catch (err) {
    logger.warn({ ...describeGraphError(err), stage, timeframe }, "fetchCountrySplit failed");
    return null;
  }
}

/**
 * Fetch every geo split we track, per snapshot tick:
 *   - all 3 stages at 90d (the stable baseline; follower is lifetime-only),
 *   - engaged + reached ALSO at 14d (the moving "recent reels" thermometer).
 * Missing/low-volume splits are simply omitted. Deduped so we never double-fetch.
 */
export async function fetchAllCountrySplits(): Promise<CountrySplit[]> {
  const jobs: Array<Promise<CountrySplit | null>> = [
    fetchCountrySplit("follower", "last_90_days"),
    ...(["engaged", "reached"] as const).flatMap((stage) =>
      (["last_90_days", "last_14_days"] as GeoTimeframe[]).map((tf) => fetchCountrySplit(stage, tf)),
    ),
  ];
  const results = await Promise.all(jobs);
  return results.filter((r): r is CountrySplit => r !== null);
}

// Exported for callers that want only the windowable stages (engaged, reached).
export { WINDOWABLE_STAGES };
