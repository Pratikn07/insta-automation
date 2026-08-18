import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { fetchAllReels } from "../meta/fetchMedia.js";
import { fetchReelInsights } from "../meta/mediaInsightsFetcher.js";
import { fetchAllCountrySplits } from "../meta/demographicsFetcher.js";
import { fetchProfileTotals } from "../meta/profileFetcher.js";
import { autoCreateExperimentsForNewReels, autoMeasureDueExperiments } from "./experimentService.js";
import { describeGraphError, logEvent } from "./eventLogger.js";

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
 *   2. Snapshot the account's true follower total (followers_count).
 *   3. Snapshot account-level geo demographics (3 stages).
 *   4. Upsert ReelMeta from the Graph media list; enqueue GeminiJob for any reel
 *      that has no content profile yet.
 *   5. Snapshot per-reel performance metrics (paced).
 *   6. Auto-create/measure experiments.
 *
 * ORDER MATTERS, and it is not the order these were written in. The follower
 * captures are one Graph call each and are the only irreplaceable ones — the
 * reel metrics can be re-read from Meta at any time, but a follower day we fail
 * to capture is gone forever, because Instagram exposes only the CURRENT
 * followers_count and Meta will not re-serve a demographics vector for a past
 * day. They used to run LAST, behind a `fetchAllReels()` that shares this
 * function's try/catch: any media-list hiccup aborted the tick before either
 * follower write, so a reel-API problem silently cost a follower day and left a
 * hole in the chart. Cheapest and most perishable first, and each step now
 * carries its own catch so no step can take another one down.
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

    // 1. The account's true follower total. One field read, and the only exact
    //    daily growth signal that exists — followerAllocationCore anchors every
    //    bar in the chart to it.
    let followersTotal: number | null = null;
    try {
      followersTotal = (await fetchProfileTotals()).followersTotal;
      if (followersTotal !== null) {
        await prisma.followerTotalSnapshot.create({ data: { followersTotal } });
      }
    } catch (err) {
      logger.warn(describeGraphError(err), "follower total snapshot failed");
    }

    // 2. Account-level geo demographics: 90d baseline + 14d moving thermometer
    //    (engaged & reached at both windows; follower is lifetime-only at 90d).
    let splits: Awaited<ReturnType<typeof fetchAllCountrySplits>> = [];
    try {
      splits = await fetchAllCountrySplits();
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
    } catch (err) {
      logger.warn(describeGraphError(err), "geo demographic snapshot failed");
    }

    // 3. Reel universe → upsert anchors + enqueue analysis for new reels.
    let reels: Awaited<ReturnType<typeof fetchAllReels>> = [];
    try {
      reels = await fetchAllReels();
    } catch (err) {
      logger.warn(describeGraphError(err), "reel list fetch failed; follower captures kept");
    }
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

    // 4. Per-reel performance snapshots (paced).
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
        logger.warn(
          { mediaId: r.id, ...describeGraphError(err) },
          "perf snapshot failed for reel",
        );
      }
      await sleep(PER_REEL_GAP_MS);
    }

    // 5. Auto-experiments: create one per newly-profiled recent reel, and
    //    measure any that have completed their ~14d window. Non-fatal — a failure
    //    here must not lose the snapshot we just wrote.
    let autoCreated = 0;
    let autoMeasured = 0;
    try {
      autoCreated = await autoCreateExperimentsForNewReels();
      autoMeasured = await autoMeasureDueExperiments();
    } catch {
      logger.warn({ errorCode: "auto_experiment_step_failed" }, "auto-experiment step failed");
    }

    await logEvent("snapshot_run", {
      followersTotal,
      reels: reels.length,
      enqueued,
      perfWritten,
      geoSplits: splits.map((s) => `${s.stage}@${s.timeframe}`),
      autoCreated,
      autoMeasured,
    });
    logger.info(
      {
        followersTotal,
        reels: reels.length,
        enqueued,
        perfWritten,
        geoStages: splits.length,
        autoCreated,
        autoMeasured,
      },
      "Snapshot tick complete",
    );
  } catch (err) {
    logger.error(describeGraphError(err), "snapshotWorker tick failed");
  }
}
