import { isAxiosError } from "axios";
import { insightsGraph } from "./insightsGraphClient.js";
import { describeGraphError } from "../services/eventLogger.js";
import { logger } from "../lib/logger.js";

// Per-reel performance metrics. Several reels metrics are flagged "in development"
// by Meta and can 400 on a given media (or whole-account), so we must fetch
// resiliently — one bad metric must not lose the others.
//
// API metric name -> our field. Combined into one call when possible.
const METRIC_FIELDS = {
  views: "views",
  reach: "reach",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saved",
  total_interactions: "totalInteractions",
  ig_reels_avg_watch_time: "avgWatchTimeMs",
  ig_reels_video_view_total_time: "videoViewTotalTime",
  reels_skip_rate: "skipRate",
} as const;

type ApiMetric = keyof typeof METRIC_FIELDS;
const ALL_METRICS = Object.keys(METRIC_FIELDS) as ApiMetric[];

export interface ReelInsights {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  totalInteractions: number | null;
  avgWatchTimeMs: number | null;
  videoViewTotalTime: number | null;
  skipRate: number | null;
  /** Diagnostics: which metrics couldn't be fetched, plus the raw values map. */
  raw: { values: Record<string, number>; failed: string[] };
}

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
}

function emptyInsights(): ReelInsights {
  return {
    views: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saved: null,
    totalInteractions: null,
    avgWatchTimeMs: null,
    videoViewTotalTime: null,
    skipRate: null,
    raw: { values: {}, failed: [] },
  };
}

async function getMetrics(mediaId: string, metrics: ApiMetric[]): Promise<Record<string, number>> {
  const { data } = await insightsGraph.get<InsightsResponse>(`/${mediaId}/insights`, {
    params: { metric: metrics.join(",") },
  });
  const out: Record<string, number> = {};
  for (const d of data.data ?? []) {
    const v = d.values?.[0]?.value;
    if (d.name && typeof v === "number") out[d.name] = v;
  }
  return out;
}

/**
 * Fetch all reel insight metrics. Tries one combined call first (cheap); if it
 * 400s (an in-development metric the account can't serve), falls back to fetching
 * each metric alone and keeps whatever succeeds. Returns partial data + a `raw`
 * record of what failed, never throws for a metric-level problem.
 */
export async function fetchReelInsights(mediaId: string): Promise<ReelInsights> {
  const result = emptyInsights();
  let values: Record<string, number> = {};

  try {
    values = await getMetrics(mediaId, ALL_METRICS);
  } catch (err) {
    // Combined call rejected — most likely one metric is unsupported for this
    // media. Degrade to per-metric so a single offender doesn't sink the batch.
    if (isAxiosError(err)) {
      logger.debug({ mediaId, ...describeGraphError(err) }, "Combined insights call failed; trying per-metric");
      for (const m of ALL_METRICS) {
        try {
          Object.assign(values, await getMetrics(mediaId, [m]));
        } catch {
          result.raw.failed.push(m);
        }
      }
    } else {
      throw err;
    }
  }

  result.raw.values = values;
  const fields = result as unknown as Record<string, number | null>;
  for (const [apiName, field] of Object.entries(METRIC_FIELDS) as [ApiMetric, string][]) {
    const v = values[apiName];
    if (typeof v === "number") fields[field] = v;
  }
  return result;
}
