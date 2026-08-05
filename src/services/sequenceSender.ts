import type { DmMessageSource, ResourceMessage } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { sendTrackedMedia, sendTrackedText } from "./dmDeliveryService.js";

const STEP_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver a resource's messages in order.
 *
 * Takes ONE object rather than positional arguments so a new caller cannot omit
 * `source` — every outbound message must be attributable, and a forgotten source
 * would silently record the wrong kind of send.
 *
 * Delivery behaviour is unchanged: same order, same 800ms pacing, same rethrow on
 * failure so each caller's existing error handling still runs.
 */
export async function sendSequence(input: {
  igUserId: string;
  messages: ResourceMessage[];
  source: DmMessageSource;
}): Promise<void> {
  const { igUserId, messages, source } = input;
  const ordered = [...messages].sort((a, b) => a.order - b.order);

  for (const m of ordered) {
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
      logger.error({ err, step: m.id, type: m.type }, "Sequence step failed");
      throw err;
    }
  }
}
