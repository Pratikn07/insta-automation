import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { analyzeReel, computeProfileColumns } from "./geminiAnalysisService.js";
import { computeUsFit } from "./usFitScore.js";
import { geminiEnabled } from "../meta/geminiClient.js";
import { logEvent } from "./eventLogger.js";

// Backoff for a job that keeps failing (mirrors gateQueueWorker's math).
const BASE_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const MAX_BACKOFF_MS = 12 * 60 * 60 * 1000; // 12 h
const MAX_ATTEMPTS = 5; // after this, mark failed and stop retrying
const PER_JOB_GAP_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Sum today's Gemini spend (from content profiles) for the daily-budget guard. */
async function spentTodayUsd(): Promise<number> {
  const rows = await prisma.reelContentProfile.findMany({
    where: { createdAt: { gte: startOfTodayUtc() } },
    select: { costUsd: true },
  });
  return rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
}

/**
 * One Gemini queue tick. Non-throwing (mirrors runGateQueueTick): no-ops when the
 * key is unset, drains a small paced batch of due jobs, writes the content profile
 * + recomputes the reel's cached US-fit score, and stops the tick early if the
 * daily budget is exhausted.
 */
export async function runGeminiQueueTick(): Promise<void> {
  if (!geminiEnabled) return; // optional feature; app runs fine without a key

  try {
    let spent = await spentTodayUsd();
    if (spent >= env.GEMINI_DAILY_BUDGET_USD) return; // budget spent for the day

    const due = await prisma.geminiJob.findMany({
      where: { status: "pending", nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: "asc" },
      take: env.GEMINI_BATCH,
    });
    if (due.length === 0) return;

    let analyzed = 0;
    for (const job of due) {
      if (spent >= env.GEMINI_DAILY_BUDGET_USD) {
        logger.info({ analyzed }, "Gemini daily budget reached — stopping tick");
        break;
      }

      const reel = await prisma.reelMeta.findUnique({ where: { mediaId: job.mediaId } });
      if (!reel) {
        await prisma.geminiJob.update({
          where: { mediaId: job.mediaId },
          data: { status: "skipped", lastError: "reel_meta_missing" },
        });
        continue;
      }

      await prisma.geminiJob.update({ where: { mediaId: job.mediaId }, data: { status: "running" } });

      try {
        const result = await analyzeReel({
          mediaUrl: reel.mediaUrl,
          caption: reel.caption,
          mediaAudioType: reel.manualAudioType ?? reel.mediaAudioType,
        });

        const fit = computeUsFit(
          result.profile,
          result.source,
          reel.manualAudioType ?? reel.mediaAudioType,
        );
        const cols = computeProfileColumns(result.profile);

        // Persist profile + cached score together. Upsert so a re-analysis
        // (bumped PROMPT_VERSION) cleanly replaces the prior profile.
        await prisma.$transaction([
          prisma.reelContentProfile.upsert({
            where: { mediaId: job.mediaId },
            create: {
              mediaId: job.mediaId,
              source: result.source,
              promptVersion: result.promptVersion,
              modelId: result.modelId,
              profile: result.profile as object,
              costUsd: result.costUsd,
              ...cols,
            },
            update: {
              source: result.source,
              promptVersion: result.promptVersion,
              modelId: result.modelId,
              profile: result.profile as object,
              costUsd: result.costUsd,
              ...cols,
            },
          }),
          prisma.reelMeta.update({
            where: { mediaId: job.mediaId },
            data: { usFitScore: fit.score, confidence: fit.confidence, scoredAt: new Date() },
          }),
          prisma.geminiJob.update({
            where: { mediaId: job.mediaId },
            data: { status: "done", attempts: job.attempts + 1, lastError: null },
          }),
        ]);

        spent += result.costUsd;
        analyzed++;
        await logEvent("gemini_analyzed", {
          mediaId: job.mediaId,
          source: result.source,
          score: fit.score,
          confidence: fit.confidence,
        });
      } catch (err) {
        const attempts = job.attempts + 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempts >= MAX_ATTEMPTS) {
          await prisma.geminiJob.update({
            where: { mediaId: job.mediaId },
            data: { status: "failed", attempts, lastError: msg },
          });
        } else {
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
          await prisma.geminiJob.update({
            where: { mediaId: job.mediaId },
            data: {
              status: "pending",
              attempts,
              lastError: msg,
              nextAttemptAt: new Date(Date.now() + backoff),
            },
          });
        }
        logger.warn({ mediaId: job.mediaId, err: msg }, "Gemini analysis failed");
      }

      await sleep(PER_JOB_GAP_MS);
    }

    if (analyzed > 0) logger.info({ analyzed }, "Gemini queue worker analyzed reels");
  } catch (err) {
    logger.error({ err }, "geminiQueueWorker tick failed");
  }
}
