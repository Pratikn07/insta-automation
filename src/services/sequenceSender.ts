import type { DmMessageSource, ResourceMessage } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { sendTrackedMedia, sendTrackedText } from "./dmDeliveryService.js";
import { describeGraphError } from "./eventLogger.js";
import { exceedsInstagramTextLimit, instagramTextChars } from "../lib/instagramLimits.js";

const STEP_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver a resource's messages in order.
 *
 * Takes ONE object rather than positional arguments so a new caller cannot omit
 * `source` — every outbound message must be attributable, and a forgotten source
 * would silently record the wrong kind of send.
 *
 * Delivery behaviour on a Graph failure is unchanged: same order, same 800ms
 * pacing, same rethrow so each caller's existing error handling still runs.
 *
 * The one change is a step that provably cannot be delivered. Instagram rejects
 * text over 1,000 characters, and because the rethrow above aborts the loop,
 * one over-length step used to take the whole remainder of the guide with it.
 * "Cardboard" was failing at step 2 of 5: 21 people received two activities,
 * never saw the last three, and never reached the closing message — and because
 * the throw happened before markCompleted, their conversation never completed
 * or scheduled a follow-up either.
 *
 * The threshold is characters, and getting that wrong here is expensive in the
 * same direction as the bug: this guard SKIPS what it flags, so an over-strict
 * measure deletes messages that would have arrived. It briefly measured bytes,
 * which would have dropped the first step of "potty" for ~194 people a month.
 * See instagramLimits.ts.
 *
 * Such a step is now skipped rather than attempted: it is recorded, and delivery
 * continues. This is deliberately NOT a general "continue past errors" — a rate
 * limit or an auth failure still aborts, because those say something about the
 * next step too, and hammering a throttled API helps nobody. An over-length body
 * says something about that step alone, and retrying it will never succeed.
 */
export async function sendSequence(input: {
  igUserId: string;
  messages: ResourceMessage[];
  source: DmMessageSource;
}): Promise<void> {
  const { igUserId, messages, source } = input;
  const ordered = [...messages].sort((a, b) => a.order - b.order);

  const skipped: { id: string; chars: number }[] = [];

  for (const m of ordered) {
    // Checked before the call, not after the rejection: an over-length body
    // spends a request and a rate-limit slot to learn what we already know.
    if (m.body && exceedsInstagramTextLimit(m.body)) {
      const chars = instagramTextChars(m.body);
      skipped.push({ id: m.id, chars });
      logger.error(
        { step: m.id, type: m.type, chars, limit: 1000, errorCode: "step_over_char_limit" },
        "Sequence step skipped: text exceeds Instagram's 1000-character limit",
      );
      continue;
    }

    try {
      if (m.type === "text") {
        if (!m.body) continue;
        await sendTrackedText({ recipientIgUserId: igUserId, text: m.body, source });
      } else if (m.type === "image") {
        if (!m.mediaUrl) continue;
        await sendTrackedMedia({
          recipientIgUserId: igUserId,
          type: "image",
          url: m.mediaUrl,
          source,
        });
        if (m.body) await sendTrackedText({ recipientIgUserId: igUserId, text: m.body, source });
      } else if (m.type === "pdf") {
        if (!m.mediaUrl) continue;
        await sendTrackedMedia({
          recipientIgUserId: igUserId,
          type: "file",
          url: m.mediaUrl,
          source,
        });
        if (m.body) await sendTrackedText({ recipientIgUserId: igUserId, text: m.body, source });
      }
      await sleep(STEP_DELAY_MS);
    } catch (err) {
      logger.error(
        { step: m.id, type: m.type, ...describeGraphError(err) },
        "Sequence step failed",
      );
      throw err;
    }
  }

  // Reported, never silent. The guide went out incomplete, and the count of
  // what was dropped belongs in the log beside the delivery that succeeded.
  if (skipped.length > 0) {
    logger.warn(
      { skipped: skipped.length, steps: skipped, errorCode: "sequence_partially_delivered" },
      "Sequence delivered with steps omitted for length",
    );
  }
}
