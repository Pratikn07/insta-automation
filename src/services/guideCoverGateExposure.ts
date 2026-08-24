import type { ResourceMessage } from "@prisma/client";

import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sendTrackedMedia } from "./dmDeliveryService.js";
import { logEvent } from "./eventLogger.js";

/**
 * Show the guide's cover to a NON-FOLLOWER, at the moment they are asked to follow.
 *
 * This is the highest-leverage placement in the funnel, and the numbers are not close. In
 * the 7 days to 2026-08-24, 1,751 of 1,770 conversations were gated non-followers, and 926
 * of those never converted — for more than half the people who ask for a guide, the gate
 * message is the ONLY thing TinySoho ever sends them. A cover attached to the guide reaches
 * the 47% who follow through; a cover at the gate reaches everyone.
 *
 * It rides the ordinary DM gate (`sendTrackedText` from messageHandler), not the private
 * reply. That distinction is what makes this possible at all: Meta permits exactly one
 * private reply per comment, so the comment path could only carry art and copy together
 * inside a template card — an unverified capability behind a flag that is off. The DM gate
 * has no such limit, so an image followed by the ask is two ordinary messages on a path
 * that already sends thousands a day.
 */

export const GATE_COVER_EVENT = "guide_gate_cover_sent";

/**
 * The attached cover, or null.
 *
 * Read from the guide's own authored messages rather than from `resource_cover_version`, so
 * the gate and the delivery can only ever show the SAME bytes: both resolve the identical
 * `order: -1` row. Reading the published cover here instead would let the two drift the
 * moment a new cover is published but not yet attached.
 */
export function attachedCoverMessage(
  messages: readonly ResourceMessage[],
): ResourceMessage | null {
  return (
    messages.find(
      (message) =>
        message.order === -1 && message.type === "image" && Boolean(message.mediaUrl),
    ) ?? null
  );
}

/**
 * Send the cover ahead of the gate. Best-effort by construction.
 *
 * Returns whether the parent actually saw it, which is what the delivery side needs — NOT
 * whether a cover exists. The gate text is the message that converts, so a cover failure
 * must never prevent it: the caller sends the ask regardless, and a false return means the
 * guide keeps its cover at delivery instead of the parent getting none at all.
 */
export async function sendCoverBeforeGate(input: {
  conversationId: string;
  resourceId: string;
  recipientIgUserId: string;
  messages: readonly ResourceMessage[];
}): Promise<boolean> {
  const cover = attachedCoverMessage(input.messages);
  if (!cover?.mediaUrl) return false;

  try {
    await sendTrackedMedia({
      recipientIgUserId: input.recipientIgUserId,
      type: "image",
      url: cover.mediaUrl,
      source: "keyword_automation",
    });
  } catch (error) {
    // Deliberately swallowed. Logged so a systematic failure is visible, but never
    // rethrown: the parent is mid-gate and the ask still has to reach them.
    logger.warn(
      {
        errorCode: "guide_gate_cover_failed",
        conversationId: input.conversationId,
        resourceId: input.resourceId,
      },
      "Guide cover failed ahead of the gate; sending the gate anyway",
    );
    return false;
  }

  // Durable, because the gate and the delivery are different webhook invocations — the
  // parent leaves to follow and comes back minutes or hours later, in a new process. An
  // in-memory flag would be gone, and `conversations.gatedAt` cannot be used for this: it
  // records that the GATE was sent, which stays true when the cover failed, so suppressing
  // on it would silently leave those parents with no cover anywhere.
  await logEvent(GATE_COVER_EVENT, {
    conversationId: input.conversationId,
    resourceId: input.resourceId,
  });
  return true;
}

/** Whether this conversation was already shown its cover at the gate. */
export async function wasCoverShownAtGate(conversationId: string): Promise<boolean> {
  try {
    const seen = await prisma.eventLog.findFirst({
      where: {
        kind: GATE_COVER_EVENT,
        payload: { path: ["conversationId"], equals: conversationId },
      },
      select: { id: true },
    });
    return seen !== null;
  } catch {
    // Fail towards showing the cover. A duplicate image is a blemish; a guide that silently
    // lost its cover because a lookup failed is the worse outcome, and the harder one to
    // notice.
    logger.error(
      { errorCode: "guide_gate_cover_lookup_failed", conversationId },
      "Could not determine whether the cover was shown at the gate",
    );
    return false;
  }
}

/**
 * Drop the attached cover when the parent has already seen it.
 *
 * Filters the authored messages rather than teaching `sendSequence` about covers, so the
 * sender stays a dumb ordered pipe and the decision lives with the caller that knows the
 * conversation's history.
 */
export function withoutAlreadyShownCover(
  messages: readonly ResourceMessage[],
  shownAtGate: boolean,
): ResourceMessage[] {
  if (!shownAtGate) return [...messages];
  const cover = attachedCoverMessage(messages);
  if (!cover) return [...messages];
  return messages.filter((message) => message.id !== cover.id);
}
