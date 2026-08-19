import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";
import type { Prisma } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { geminiEnabled } from "../meta/geminiClient.js";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";
import { classifyIdentityPresence } from "./historicalAudienceSegment.js";
import { logEvent } from "./eventLogger.js";
import {
  classifyOrigins,
  estimateOriginCostUsd,
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
    where: { originCheckedAt: { gte: startOfTodayUtc() }, originMethod: CURRENT_ORIGIN_METHOD },
  });
  // Cost is per BATCH, not per row, and is not stored per user (a cost column on
  // ig_users would be storing an accounting fact on a person). Reconstruct it
  // from the row count at the batch rate — exact whenever batches are full,
  // and an over-estimate otherwise, which errs toward stopping early.
  const batches = Math.ceil(classifiedToday / MAX_ORIGIN_BATCH);
  return batches * estimateOriginCostUsd(MAX_ORIGIN_BATCH) + unrecordedSpendToday();
}

const ORIGIN_STILL_DUE = {
  OR: [
    { originCheckedAt: null },
    { originMethod: null },
    { originMethod: { not: CURRENT_ORIGIN_METHOD } },
  ],
} satisfies Prisma.IgUserWhereInput;

/**
 * Persist classifier output only for the exact identity snapshot that was sent to
 * Gemini and only while it still needs this method revision. A profile update clears
 * origin fields; matching name and username prevents a delayed old response from
 * immediately restoring a verdict for the prior identity.
 */
async function compareAndSetOrigin(
  writes: Array<{
    candidate: OriginCandidate;
    data: Prisma.IgUserUpdateManyMutationInput;
  }>,
): Promise<number> {
  if (writes.length === 0) return 0;
  const results = await prisma.$transaction(
    writes.map(({ candidate, data }) => prisma.igUser.updateMany({
      where: {
        id: candidate.id,
        username: candidate.username,
        name: candidate.name,
        ...ORIGIN_STILL_DUE,
      },
      data,
    })),
  );
  return results.reduce((count, write) => count + write.count, 0);
}

/**
 * Classify a paced batch of users with no current-method origin result.
 *
 * Non-throwing, mirroring runGeminiQueueTick: this is an enrichment pass, and a
 * failure must never take down the caller. An unclassified user is not a broken
 * user — the recovery gate falls back to the name-token screen.
 */
export async function runOriginEnrichmentTick(): Promise<OriginEnrichmentResult> {
  if (!flags.bool("DM_RECOVERY_ORIGIN_LLM_ENABLED")) return emptyResult("disabled");
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
    where: ORIGIN_STILL_DUE,
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
  const noSignal: OriginCandidate[] = [];
  for (const u of due) {
    if (classifyIdentityPresence(u) === null) classifiable.push(u);
    else noSignal.push(u);
  }

  // Each write carries the identity snapshot even though the stamp is identical.
  if (noSignal.length > 0) {
    result.skippedNoSignal += await compareAndSetOrigin(noSignal.map((candidate) => ({
      candidate,
      data: {
        inferredOrigin: "unknown",
        originConfidence: "low",
        originMethod: CURRENT_ORIGIN_METHOD,
        originEvidence: "no name or username to classify",
        audienceSegment: "unknown_no_name",
        originCheckedAt: now,
      },
    })));
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

  const candidateById = new Map(classifiable.map((candidate) => [candidate.id, candidate]));
  result.classified += await compareAndSetOrigin(
    verdicts.flatMap((v) => {
      const candidate = candidateById.get(v.id);
      return candidate ? [{
        candidate,
        data: {
          inferredOrigin: v.origin,
          originConfidence: v.confidence,
          originMethod: CURRENT_ORIGIN_METHOD,
          originEvidence: v.evidence,
          audienceSegment: v.audienceSegment,
          originCheckedAt: now,
        },
      }] : [];
    }),
  );

  // The model answered, so anyone it left out is someone it declined to place
  // rather than a failed call. Stamping them `unknown` stops the query
  // returning them every two minutes forever, which re-billed the same rows
  // indefinitely once the backlog drained. `unknown` never withholds a
  // reminder, so this errs toward sending; a prompt-version bump re-runs them.
  const classified = new Set(verdicts.map((v) => v.id));
  const unplaced = classifiable.filter((c) => !classified.has(c.id));
  if (unplaced.length > 0) {
    result.skippedNoSignal += await compareAndSetOrigin(unplaced.map((candidate) => ({
      candidate,
      data: {
        inferredOrigin: "unknown",
        originConfidence: "low",
        originMethod: CURRENT_ORIGIN_METHOD,
        originEvidence: "model returned no verdict for this account",
        audienceSegment: "unknown_generic",
        originCheckedAt: now,
      },
    })));
  }

  await logEvent("origin_enrichment_tick", {
    examined: result.examined,
    classified: result.classified,
    skippedNoSignal: result.skippedNoSignal,
    costUsd: Number(result.costUsd.toFixed(6)),
    promptVersion: CURRENT_ORIGIN_METHOD,
  });

  return result;
}
