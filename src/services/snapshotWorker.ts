import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { fetchAllReels } from "../meta/fetchMedia.js";
import { fetchReelInsights } from "../meta/mediaInsightsFetcher.js";
import { fetchAllCountrySplits } from "../meta/demographicsFetcher.js";
import { logEvent } from "./eventLogger.js";

// Gentle spacing between per-reel insight calls, same spirit as the gate worker's
// PER_SEND_GAP_MS — stay well under any account rate limit.
const PER_REEL_GAP_MS = 1500;
// Self-throttle: don't take a full snapshot more often than this, even if the
// interval timer fires sooner (protects against a small dev SNAPSHOT_INTERVAL_MS).
const MIN_SNAPSHOT_AGE_MS = 60 * 60 * 1000; // 1 h

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One snapshot tick. Fully non-throwing — a failure here must never crash the
 * server (mirrors runGateQueueTick). Steps:
 *   1. Self-throttle on the newest snapshot's age.
 *   2. Upsert ReelMeta from the Graph media list; enqueue GeminiJob for any reel
 *      that has no content profile yet.
 *   3. Snapshot per-reel performance metrics (paced).
 *   4. Snapshot account-level geo demographics (3 stages).
 */
export async function runSnapshotTick(): Promise<void> {
  try {
    const newest = await prisma.geoDemographicSnapshot.findFirst({
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    });
    if (newest && Date.now() - newest.capturedAt.getTime() < MIN_SNAPSHOT_AGE_MS) {
      return; // too soon since the last snapshot
    }

    // 1. Reel universe → upsert anchors + enqueue analysis for new reels.
    const reels = await fetchAllReels();
    let enqueued = 0;
    for (const r of reels) {
      const mediaUrl = r.mediaUrl ?? null;
      await prisma.reelMeta.upsert({
        where: { mediaId: r.id },
        create: {
          mediaId: r.id,
          caption: r.caption,
          permalink: r.permalink,
          thumbnailUrl: r.thumbnailUrl,
          mediaUrl,
          postedAt: r.timestamp ? new Date(r.timestamp) : null,
          mediaAudioType: r.mediaAudioType ?? null,
          videoUnavailable: !mediaUrl,
        },
        update: {
          caption: r.caption,
          permalink: r.permalink,
          thumbnailUrl: r.thumbnailUrl,
          mediaUrl,
          postedAt: r.timestamp ? new Date(r.timestamp) : null,
          mediaAudioType: r.mediaAudioType ?? null,
          videoUnavailable: !mediaUrl,
        },
      });

      // Enqueue a Gemini job only if this reel has never been profiled and isn't
      // already queued. Cache-forever: we never re-enqueue an analyzed reel here.
      const hasProfile = await prisma.reelContentProfile.findUnique({
        where: { mediaId: r.id },
        select: { mediaId: true },
      });
      if (!hasProfile) {
        await prisma.geminiJob.upsert({
          where: { mediaId: r.id },
          create: { mediaId: r.id },
          update: {}, // leave existing job state alone
        });
        enqueued++;
      }
    }

    // 2. Per-reel performance snapshots (paced).
    let perfWritten = 0;
    for (const r of reels) {
      try {
        const ins = await fetchReelInsights(r.id);
        await prisma.reelPerformanceSnapshot.create({
          data: {
            mediaId: r.id,
            views: ins.views,
            reach: ins.reach,
            likes: ins.likes,
            comments: ins.comments,
            shares: ins.shares,
            saved: ins.saved,
            totalInteractions: ins.totalInteractions,
            avgWatchTimeMs: ins.avgWatchTimeMs,
            videoViewTotalTime: ins.videoViewTotalTime,
            skipRate: ins.skipRate,
            raw: ins.raw,
          },
        });
        perfWritten++;
      } catch (err) {
        logger.warn({ err, mediaId: r.id }, "perf snapshot failed for reel");
      }
      await sleep(PER_REEL_GAP_MS);
    }

    // 3. Account-level geo demographics: 90d baseline + 14d moving thermometer
    //    (engaged & reached at both windows; follower is lifetime-only at 90d).
    const splits = await fetchAllCountrySplits();
    for (const s of splits) {
      await prisma.geoDemographicSnapshot.create({
        data: {
          stage: s.stage,
          timeframe: s.timeframe,
          counts: s.counts,
          usPct: s.usPct,
          inPct: s.inPct,
          totalCounted: s.totalCounted,
        },
      });
    }

    await logEvent("snapshot_run", {
      reels: reels.length,
      enqueued,
      perfWritten,
      geoSplits: splits.map((s) => `${s.stage}@${s.timeframe}`),
    });
    logger.info(
      { reels: reels.length, enqueued, perfWritten, geoStages: splits.length },
      "Snapshot tick complete",
    );
  } catch (err) {
    logger.error({ err }, "snapshotWorker tick failed");
  }
}
