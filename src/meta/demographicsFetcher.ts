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

export interface CountrySplit {
  stage: GeoStage;
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
export async function fetchCountrySplit(stage: GeoStage): Promise<CountrySplit | null> {
  try {
    const { data } = await insightsGraph.get<DemographicsResponse>(`/${env.IG_USER_ID}/insights`, {
      params: {
        metric: STAGE_METRIC[stage],
        period: "lifetime",
        timeframe: "last_90_days",
        breakdown: "country",
        metric_type: "total_value",
      },
    });
    const counts = extractCountryCounts(data);
    const totalCounted = Object.values(counts).reduce((s, v) => s + v, 0);
    return {
      stage,
      counts,
      totalCounted,
      usPct: pct(counts, "US", totalCounted),
      inPct: pct(counts, "IN", totalCounted),
    };
  } catch (err) {
    logger.warn({ ...describeGraphError(err), stage }, "fetchCountrySplit failed");
    return null;
  }
}

/** Fetch all three stages; missing stages are simply omitted from the result. */
export async function fetchAllCountrySplits(): Promise<CountrySplit[]> {
  const stages: GeoStage[] = ["follower", "engaged", "reached"];
  const results = await Promise.all(stages.map(fetchCountrySplit));
  return results.filter((r): r is CountrySplit => r !== null);
}
