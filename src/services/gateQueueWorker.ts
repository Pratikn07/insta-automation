import { isAxiosError } from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { sendPrivateReply, sendTextMessage } from "../meta/sendMessage.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { PRIVATE_REPLY_WINDOW_MS } from "./gateQueueService.js";

// The rate-limit subcode. When we see it again we back off for the rest of the tick.
const RATE_LIMIT_SUBCODE = 2534025;

// Spacing between retries for a single row that keeps hitting the limit (grows
// with attempts, capped). Sends for DIFFERENT rows in a tick are also spaced.
// The cap was 12h — a relic of the June 2534025 storm. With the rate limit now
// rare (~5/week) and the queue routinely drained, a 12h cap only stranded the
// occasional failing gate for half a day between tries, dragging the delivery
// tail (p90 was ~1.8d). A 2h cap tightens that; real storms are still handled by
// the adaptive per-tick break below (we stop the tick the moment 2534025 recurs),
// so faster retries never hammer a limited account.
const BASE_BACKOFF_MS = 15 * 60 * 1000; // 15 min
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000; // 2 h
const PER_SEND_GAP_MS = 4000; // gentle spacing between sends within a tick

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const data = err.response?.data as { error?: { error_subcode?: number } } | undefined;
  return data?.error?.error_subcode === RATE_LIMIT_SUBCODE;
}

/**
 * One worker tick: drain a small, paced batch of pending gate retries that are due
 * and still inside the 7-day private-reply window. Adaptive: stops early for this
 * tick the moment the rate limit reappears (no point hammering a closed window),
 * and processes oldest-first so nobody starves.
 *
 * Fully non-throwing — a worker crash must never take down the server.
 */
export async function runGateQueueTick(): Promise<void> {
  try {
    const now = Date.now();
    const windowStart = new Date(now - PRIVATE_REPLY_WINDOW_MS);

    // Mark rows whose 7-day window has closed as exhausted (can't private-reply anymore).
    await prisma.gateQueue.updateMany({
      where: { status: "pending", commentAt: { lt: windowStart } },
      data: { status: "exhausted" },
    });

    const due = await prisma.gateQueue.findMany({
      where: {
        status: "pending",
        nextAttemptAt: { lte: new Date(now) },
        commentAt: { gte: windowStart },
      },
      orderBy: { commentAt: "asc" },
      take: env.GATE_RETRY_BATCH,
    });

    if (due.length === 0) {
      await maybeRunExperiment();
      return;
    }

    let sent = 0;
    for (const row of due) {
      try {
        await sendPrivateReply(row.commentId, row.gateMessage);
        await prisma.gateQueue.update({
          where: { id: row.id },
          data: { status: "sent", attempts: row.attempts + 1, lastError: null },
        });
        // Re-arm the conversation: the user has now actually received the gate, so
        // open the DONE-window from this moment. Without this, the reply lands on
        // an expired conversation and is dropped (the retry-gate state bug).
        await prisma.conversation.update({
          where: { id: row.conversationId },
          data: { state: "awaiting_done", gatedAt: new Date() },
        });
        await logEvent("dm_sent", {
          conversationId: row.conversationId,
          kind: "gate",
          source: "retry",
        });
        sent++;
        await sleep(PER_SEND_GAP_MS);
      } catch (err) {
        const detail = describeGraphError(err);
        const attempts = row.attempts + 1;
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
        await prisma.gateQueue.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: typeof detail.message === "string" ? detail.message : "error",
            nextAttemptAt: new Date(Date.now() + backoff),
          },
        });

        // Adaptive: if we hit the rate limit, the account window is closed right
        // now — stop this tick rather than burning more failed calls.
        if (isRateLimit(err)) {
          logger.info(
            { sentThisTick: sent, remaining: due.length - sent },
            "Gate retry hit rate limit — backing off for this tick",
          );
          break;
        }
      }
    }

    if (sent > 0) logger.info({ sent }, "Gate retry worker delivered queued gates");
  } catch (err) {
    logger.error({ err }, "gateQueueWorker tick failed");
  }
}

/**
 * Measured experiment (off by default, GATE_DM_EXPERIMENT=true): for a couple of
 * already-exhausted users, try a STANDARD DM (recipient:{id}) — the channel we
 * believe Instagram blocks for cold users. Logged distinctly so we learn, at zero
 * cost, whether it's ever accepted. Never runs on fresh/pending users.
 */
async function maybeRunExperiment(): Promise<void> {
  if (!env.GATE_DM_EXPERIMENT) return;
  try {
    const sample = await prisma.gateQueue.findMany({
      where: { status: "exhausted", lastError: { not: "experiment_done" } },
      orderBy: { updatedAt: "asc" },
      take: 2,
    });
    for (const row of sample) {
      try {
        await sendTextMessage(row.igUserId, row.gateMessage);
        await logEvent("gate_dm_experiment_ok", {
          conversationId: row.conversationId,
          igUserId: row.igUserId,
        });
      } catch (err) {
        await logEvent("gate_dm_experiment_failed", {
          conversationId: row.conversationId,
          igUserId: row.igUserId,
          ...describeGraphError(err),
        });
      }
      await prisma.gateQueue.update({
        where: { id: row.id },
        data: { lastError: "experiment_done" },
      });
      await sleep(PER_SEND_GAP_MS);
    }
  } catch (err) {
    logger.error({ err }, "gate DM experiment failed");
  }
}
