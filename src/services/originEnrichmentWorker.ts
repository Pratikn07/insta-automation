import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { geminiEnabled } from "../meta/geminiClient.js";
import { logEvent } from "./eventLogger.js";
import {
  classifyOrigins,
  estimateOriginCostUsd,
  ORIGIN_PROMPT_VERSION,
  MAX_ORIGIN_BATCH,
  type OriginCandidate,
} from "./originClassifier.js";

export type OriginEnrichmentResult = {
  examined: number;
  classified: number;
  skippedNoSignal: number;
  costUsd: number;
  skipped?: "disabled" | "already_running" | "budget" | "no_work";
};

let running = false;

function emptyResult(skipped: OriginEnrichmentResult["skipped"]): OriginEnrichmentResult {
  return { examined: 0, classified: 0, skippedNoSignal: 0, costUsd: 0, skipped };
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Today's origin-classification spend, for the shared daily budget guard.
 *
 * Deliberately counts only THIS feature's rows. The reel analyser sums its own
 * spend from reel_content_profiles; adding both here would double-charge the
 * budget against a table this worker never writes.
 */
async function spentTodayUsd(): Promise<number> {
  const rows = await prisma.igUser.findMany({
    where: { originCheckedAt: { gte: startOfTodayUtc() }, originMethod: ORIGIN_PROMPT_VERSION },
    select: { id: true },
  });
  // Cost is per BATCH, not per row, and is not stored per user (a cost column on
  // ig_users would be storing an accounting fact on a person). Reconstruct it
  // from the row count at the batch rate — exact whenever batches are full,
  // and an over-estimate otherwise, which errs toward stopping early.
  const batches = Math.ceil(rows.length / MAX_ORIGIN_BATCH);
  return batches * estimateOriginCostUsd(MAX_ORIGIN_BATCH);
}

/**
 * A user with neither a name nor a username cannot be classified by any method,
 * so sending them to the model spends budget to be told "unknown".
 *
 * They are stamped as checked with origin `unknown` so the query does not return
 * them forever, and so the dashboard can tell "we looked and there was nothing"
 * apart from "not yet looked at".
 */
function hasSignal(u: { username: string | null; name: string | null }): boolean {
  const clean = (s: string | null) => (s ?? "").trim().replace(/^-+$/, "");
  return Boolean(clean(u.username) || clean(u.name));
}

/**
 * Classify a paced batch of not-yet-checked users.
 *
 * Non-throwing, mirroring runGeminiQueueTick: this is an enrichment pass, and a
 * failure must never take down the caller. An unclassified user is not a broken
 * user — the recovery gate falls back to the name-token screen.
 */
export async function runOriginEnrichmentTick(): Promise<OriginEnrichmentResult> {
  if (!env.DM_RECOVERY_ORIGIN_LLM_ENABLED) return emptyResult("disabled");
  if (!geminiEnabled) return emptyResult("disabled");
  if (running) return emptyResult("already_running");
  running = true;
  try {
    return await tickBody();
  } catch (error) {
    logger.error(
      { errorCode: "origin_enrichment_failed", message: (error as Error)?.message },
      "Origin enrichment tick failed",
    );
    return emptyResult(undefined);
  } finally {
    running = false;
  }
}

async function tickBody(): Promise<OriginEnrichmentResult> {
  const spent = await spentTodayUsd();
  if (spent >= env.GEMINI_DAILY_BUDGET_USD) return emptyResult("budget");

  const batchSize = Math.min(env.DM_RECOVERY_ORIGIN_BATCH_SIZE, MAX_ORIGIN_BATCH);

  // Newest first. New arrivals are the ones with a reminder already ticking
  // toward its ten-hour send; an old unclassified row has no deadline.
  const due = await prisma.igUser.findMany({
    where: { originCheckedAt: null },
    select: { id: true, username: true, name: true },
    orderBy: { createdAt: "desc" },
    take: batchSize,
  });
  if (due.length === 0) return emptyResult("no_work");

  const now = new Date();
  const result: OriginEnrichmentResult = {
    examined: due.length,
    classified: 0,
    skippedNoSignal: 0,
    costUsd: 0,
  };

  const classifiable: OriginCandidate[] = [];
  for (const u of due) {
    if (hasSignal(u)) {
      classifiable.push(u);
    } else {
      await prisma.igUser.update({
        where: { id: u.id },
        data: {
          inferredOrigin: "unknown",
          originConfidence: "low",
          originMethod: ORIGIN_PROMPT_VERSION,
          originEvidence: "no name or username to classify",
          originCheckedAt: now,
        },
      });
      result.skippedNoSignal++;
    }
  }

  if (classifiable.length === 0) return result;

  const { verdicts, costUsd } = await classifyOrigins(classifiable);
  result.costUsd = costUsd;

  for (const v of verdicts) {
    await prisma.igUser.update({
      where: { id: v.id },
      data: {
        inferredOrigin: v.origin,
        originConfidence: v.confidence,
        originMethod: ORIGIN_PROMPT_VERSION,
        originEvidence: v.evidence,
        originCheckedAt: now,
      },
    });
    result.classified++;
  }

  // Rows the model skipped keep originCheckedAt null on purpose, so the next
  // tick retries them. They stay on the name-token fallback until then.
  await logEvent("origin_enrichment_tick", {
    examined: result.examined,
    classified: result.classified,
    skippedNoSignal: result.skippedNoSignal,
    costUsd: Number(result.costUsd.toFixed(6)),
    promptVersion: ORIGIN_PROMPT_VERSION,
  });

  return result;
}
