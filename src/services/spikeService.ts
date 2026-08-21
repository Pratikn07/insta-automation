import { prisma } from "../lib/prisma.js";
import type {
  FollowerDailyAddsPoint,
  SpikeCandidateInfo,
  SpikeInfo,
} from "./followerFlowCore.js";
import { analyticsDayBounds, shiftDayKey } from "./analyticsDay.js";
import { detectSpikes, rankCandidates, type ReelSnapshot } from "./spikeCore.js";

// DB-facing wrapper around spikeCore. All detection/ranking semantics live in the
// core; this file only loads rows and joins reel metadata for display.

// Attribution window around the spike day. ±1 day, because Meta's demographics
// lag means the reach that produced a spike may be logged the day before or the
// day the spike surfaces.
const WINDOW_PAD_DAYS = 1;
// Baseline lookback handed to the core so it can find a pre-window snapshot.
const BASELINE_LOOKBACK_DAYS = 2;

// The wire shapes live in followerFlowCore so a point's type has one definition;
// re-exported here for callers that only import this service.
export type { SpikeCandidateInfo, SpikeInfo };

export function spikeAttributionWindow(day: string): {
  queryStart: Date;
  windowStartMs: number;
  windowEndMs: number;
} {
  const windowStartDay = shiftDayKey(day, -WINDOW_PAD_DAYS);
  const windowEndExclusiveDay = shiftDayKey(day, WINDOW_PAD_DAYS + 1);
  const queryStartDay = shiftDayKey(windowStartDay, -BASELINE_LOOKBACK_DAYS);
  return {
    queryStart: analyticsDayBounds(queryStartDay).start,
    windowStartMs: analyticsDayBounds(windowStartDay).start.getTime(),
    windowEndMs: analyticsDayBounds(windowEndExclusiveDay).start.getTime() - 1,
  };
}

/**
 * Spike info keyed by Pacific analytics day, for the days that qualify. Days
 * absent from the map are normal.
 *
 * Two queries total, regardless of how many days spiked.
 *
 * This used to loop the spikes and issue two queries per spike day, on the
 * reasoning that "spikes are rare by construction (4 across a month of live
 * data), so this stays a handful of queries rather than an N+1". That stopped
 * being true as the series grew: a 90-day lookback now detects 13 spike days,
 * so the loop was 26 sequential round trips and the single slowest thing behind
 * /api/insights/follower-daily-adds — ~2.1s locally and most of a ten-second
 * response in production, where each round trip costs far more.
 *
 * The window arithmetic and every ranking decision are unchanged: one query
 * spans the union of the per-spike windows, then each spike is ranked over
 * exactly the bounds it would have queried for on its own.
 */
export async function getSpikesByDay(
  points: FollowerDailyAddsPoint[],
): Promise<Map<string, SpikeInfo>> {
  const spikes = detectSpikes(points);
  if (spikes.length === 0) return new Map();

  const windows = spikes.map((spike) => ({ spike, ...spikeAttributionWindow(spike.day) }));

  // Reaches back past the earliest window so the core can find a baseline
  // reading, exactly as the per-spike query did.
  const rows = await prisma.reelPerformanceSnapshot.findMany({
    where: {
      capturedAt: {
        gte: new Date(Math.min(...windows.map((w) => w.queryStart.getTime()))),
        lte: new Date(Math.max(...windows.map((w) => w.windowEndMs))),
      },
    },
    orderBy: { capturedAt: "asc" },
    select: { mediaId: true, capturedAt: true, reach: true },
  });

  const allSnapshots: ReelSnapshot[] = rows.map((r) => ({
    mediaId: r.mediaId,
    capturedAt: r.capturedAt.getTime(),
    reach: r.reach,
  }));

  // Narrow back to each spike's own window before ranking, so a wider fetch
  // cannot let one spike's reach leak into another's attribution.
  const ranked = windows
    .map((w) => {
      const queryStartMs = w.queryStart.getTime();
      const snapshots = allSnapshots.filter(
        (s) => s.capturedAt >= queryStartMs && s.capturedAt <= w.windowEndMs,
      );
      return { ...w, ranking: rankCandidates(snapshots, w.windowStartMs, w.windowEndMs) };
    })
    .filter((r) => r.ranking.candidates.length > 0);

  if (ranked.length === 0) return new Map();

  const metas = await prisma.reelMeta.findMany({
    where: {
      mediaId: {
        in: [...new Set(ranked.flatMap((r) => r.ranking.candidates.map((c) => c.mediaId)))],
      },
    },
    select: { mediaId: true, caption: true, thumbnailUrl: true, permalink: true, postedAt: true },
  });
  const metaById = new Map(metas.map((m) => [m.mediaId, m]));

  const out = new Map<string, SpikeInfo>();

  for (const { spike, ranking } of ranked) {
    out.set(spike.day, {
      multiple: spike.multiple,
      net: spike.net,
      baselineMedian: spike.baselineMedian,
      confidence: ranking.confidence,
      candidates: ranking.candidates.map((c) => {
        const meta = metaById.get(c.mediaId);
        return {
          mediaId: c.mediaId,
          caption: meta?.caption ?? null,
          thumbnailUrl: meta?.thumbnailUrl ?? null,
          permalink: meta?.permalink ?? null,
          postedAt: meta?.postedAt?.toISOString() ?? null,
          reachGained: c.reachGained,
          sharePct: c.sharePct,
        };
      }),
    });
  }

  return out;
}
