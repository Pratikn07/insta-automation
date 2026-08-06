import { isAxiosError } from "axios";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { sendTrackedPrivateReply, sendTrackedText } from "./dmDeliveryService.js";
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

// Hard ceiling on send attempts per row. Discovered the hard way (a user got 33
// copies of the same gate over 4 days): Meta sometimes DELIVERS the private
// reply but still returns an error ("An unknown error has occurred"), so a
// "failing" row can actually be spamming a real inbox. Successful sends land on
// attempt 1 in practice (sent rows avg 1.0 attempts), so a small cap loses
// nothing and bounds the worst delivered-but-errored case. Mirrors
// geminiQueueWorker's MAX_ATTEMPTS.

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

    // Retire rows already at the attempt ceiling (covers rows predating the cap).
    await prisma.gateQueue.updateMany({
      where: { status: "pending", attempts: { gte: env.GATE_MAX_ATTEMPTS } },
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

    // Never retry a gate whose conversation already completed — the user has the
    // guide (they replied to an earlier send, possibly one Meta claimed failed).
    // This is what let a completed user keep receiving "reply DONE to unlock".
    const convoStates = await prisma.conversation.findMany({
      where: { id: { in: due.map((r) => r.conversationId) } },
      select: { id: true, state: true },
    });
    const completedConvos = new Set(
      convoStates.filter((c) => c.state === "completed").map((c) => c.id),
    );

    let sent = 0;
    for (const row of due) {
      if (completedConvos.has(row.conversationId)) {
        await prisma.gateQueue.update({
          where: { id: row.id },
          data: { status: "abandoned", lastError: "conversation_completed" },
        });
        await logEvent("gate_abandoned", {
          conversationId: row.conversationId,
          reason: "conversation_completed",
          attempts: row.attempts,
        });
        continue;
      }
      try {
        await sendTrackedPrivateReply({
          recipientIgUserId: row.igUserId,
          commentId: row.commentId,
          text: row.gateMessage,
          source: "keyword_automation",
        });
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
        const lastError = detail.category;
        if (attempts >= env.GATE_MAX_ATTEMPTS) {
          // Cap reached: stop for good. Either the target is gone (dead IGSID)
          // or Meta is delivering-but-erroring — both mean more sends only harm.
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "exhausted", attempts, lastError },
          });
        } else {
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: {
              attempts,
              lastError,
              nextAttemptAt: new Date(Date.now() + backoff),
            },
          });
        }

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
    logger.error(describeGraphError(err), "gateQueueWorker tick failed");
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
        await sendTrackedText({
          recipientIgUserId: row.igUserId,
          text: row.gateMessage,
          source: "keyword_automation",
        });
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
    logger.error(describeGraphError(err), "gate DM experiment failed");
  }
}
