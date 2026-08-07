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

/**
 * Spend this process has incurred today that left no row behind — a call the
 * model answered unreadably, or one that threw after billing. The row-derived
 * figure below cannot see it, and that is precisely the spend worth stopping.
 * Process-local and reset daily; a restart forgets it, which errs toward
 * continuing rather than toward a stuck worker.
 */
let unrecordedSpendUsd = 0;
let unrecordedSpendDay = "";

function noteUnrecordedSpend(amount: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== unrecordedSpendDay) {
    unrecordedSpendDay = today;
    unrecordedSpendUsd = 0;
  }
  unrecordedSpendUsd += amount;
}

function unrecordedSpendToday(): number {
  return new Date().toISOString().slice(0, 10) === unrecordedSpendDay ? unrecordedSpendUsd : 0;
}

/** Reset process-local spend tracking. Tests only. */
export function _resetOriginSpendState(): void {
  unrecordedSpendUsd = 0;
  unrecordedSpendDay = "";
}

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
  // Only the count is needed, so count in the database. Selecting the rows to
  // read `.length` grew with a day's throughput — every tick paid to ship a
  // whole day of ids across the wire to discard them.
  const classifiedToday = await prisma.igUser.count({
    where: { originCheckedAt: { gte: startOfTodayUtc() }, originMethod: ORIGIN_PROMPT_VERSION },
  });
  // Cost is per BATCH, not per row, and is not stored per user (a cost column on
  // ig_users would be storing an accounting fact on a person). Reconstruct it
  // from the row count at the batch rate — exact whenever batches are full,
  // and an over-estimate otherwise, which errs toward stopping early.
  const batches = Math.ceil(classifiedToday / MAX_ORIGIN_BATCH);
  return batches * estimateOriginCostUsd(MAX_ORIGIN_BATCH) + unrecordedSpendToday();
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
    // Stable code only. The Gemini client carries the API key in its request
    // params, and raw error text is untrusted — the same reason the recovery
    // workers log codes rather than errors.
    logger.error({ errorCode: "origin_enrichment_failed" }, "Origin enrichment tick failed");
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
  const noSignal: string[] = [];
  for (const u of due) {
    if (hasSignal(u)) classifiable.push(u);
    else noSignal.push(u.id);
  }

  // Every no-signal row is stamped identically, so one statement does it.
  if (noSignal.length > 0) {
    await prisma.igUser.updateMany({
      where: { id: { in: noSignal } },
      data: {
        inferredOrigin: "unknown",
        originConfidence: "low",
        originMethod: ORIGIN_PROMPT_VERSION,
        originEvidence: "no name or username to classify",
        originCheckedAt: now,
      },
    });
    result.skippedNoSignal += noSignal.length;
  }

  if (classifiable.length === 0) return result;

  const { verdicts, costUsd, finishReason } = await classifyOrigins(classifiable);
  result.costUsd = costUsd;

  // Zero verdicts for a non-empty batch means the response was unreadable or
  // empty, not that these people are unclassifiable. Leave them unstamped for a
  // later tick, but record the spend, which left no row to be counted from.
  if (verdicts.length === 0) {
    noteUnrecordedSpend(costUsd);
    logger.error(
      {
        errorCode: "origin_batch_unreadable",
        batchSize: classifiable.length,
        // MAX_TOKENS here means the answer was truncated — lower the batch size
        // or check that thinking is still disabled.
        finishReason,
      },
      "Origin classification returned no usable verdicts",
    );
    return result;
  }

  // Each verdict differs, so these cannot collapse into one statement — but they
  // can travel as one round trip instead of up to fifty sequential ones.
  await prisma.$transaction(
    verdicts.map((v) =>
      prisma.igUser.update({
        where: { id: v.id },
        data: {
          inferredOrigin: v.origin,
          originConfidence: v.confidence,
          originMethod: ORIGIN_PROMPT_VERSION,
          originEvidence: v.evidence,
          originCheckedAt: now,
        },
      }),
    ),
  );
  result.classified += verdicts.length;

  // The model answered, so anyone it left out is someone it declined to place
  // rather than a failed call. Stamping them `unknown` stops the query
  // returning them every two minutes forever, which re-billed the same rows
  // indefinitely once the backlog drained. `unknown` never withholds a
  // reminder, so this errs toward sending; a prompt-version bump re-runs them.
  const classified = new Set(verdicts.map((v) => v.id));
  const unplaced = classifiable.filter((c) => !classified.has(c.id)).map((c) => c.id);
  if (unplaced.length > 0) {
    await prisma.igUser.updateMany({
      where: { id: { in: unplaced } },
      data: {
        inferredOrigin: "unknown",
        originConfidence: "low",
        originMethod: ORIGIN_PROMPT_VERSION,
        originEvidence: "model returned no verdict for this account",
        originCheckedAt: now,
      },
    });
    result.skippedNoSignal += unplaced.length;
  }

  await logEvent("origin_enrichment_tick", {
    examined: result.examined,
    classified: result.classified,
    skippedNoSignal: result.skippedNoSignal,
    costUsd: Number(result.costUsd.toFixed(6)),
    promptVersion: ORIGIN_PROMPT_VERSION,
  });

  return result;
}
