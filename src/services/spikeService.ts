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
 * One snapshot query per spike day. Spikes are rare by construction (4 across a
 * month of live data), so this stays a handful of queries rather than an N+1
 * over the whole series.
 */
export async function getSpikesByDay(
  points: FollowerDailyAddsPoint[],
): Promise<Map<string, SpikeInfo>> {
  const spikes = detectSpikes(points);
  if (spikes.length === 0) return new Map();

  const out = new Map<string, SpikeInfo>();

  for (const spike of spikes) {
    const { queryStart, windowStartMs, windowEndMs } = spikeAttributionWindow(spike.day);

    const rows = await prisma.reelPerformanceSnapshot.findMany({
      where: {
        capturedAt: {
          // Reach back past the window so the core can find a baseline reading.
          gte: queryStart,
          lte: new Date(windowEndMs),
        },
      },
      orderBy: { capturedAt: "asc" },
      select: { mediaId: true, capturedAt: true, reach: true },
    });

    const snapshots: ReelSnapshot[] = rows.map((r) => ({
      mediaId: r.mediaId,
      capturedAt: r.capturedAt.getTime(),
      reach: r.reach,
    }));

    const ranking = rankCandidates(snapshots, windowStartMs, windowEndMs);
    if (ranking.candidates.length === 0) continue;

    const metas = await prisma.reelMeta.findMany({
      where: { mediaId: { in: ranking.candidates.map((c) => c.mediaId) } },
      select: { mediaId: true, caption: true, thumbnailUrl: true, permalink: true, postedAt: true },
    });
    const metaById = new Map(metas.map((m) => [m.mediaId, m]));

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
