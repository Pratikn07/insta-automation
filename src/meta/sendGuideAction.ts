import { z } from "zod";
import {
  buildGuideGateCapabilityPayload,
  type GuideGateCapabilityPayload,
} from "./guideGatePayloads.js";
import { sendMetaMessage } from "./sendMessage.js";
import {
  guideAccessCardTitle,
  guideAccessCopy,
  guideAccessOpeningCardTitle,
  guideAccessOpening,
  guideAccessOpeningText,
  guideAccessWaitingTitle,
} from "../services/guideAccessCopy.js";
import type { MetaSendResult } from "../types/meta.js";

export const GUIDE_PROFILE_URL = "https://www.instagram.com/tinysoho/";

const opaqueActionToken = z.string().uuid();

/**
 * Rich controls are off until a reviewed capability result is explicitly passed
 * by the caller. This prevents an unsupported private-reply request from ever
 * reaching Meta and preserves the single-private-reply constraint.
 */
export type GuideActionCapabilities = {
  privateQuickReply: boolean;
  dmGenericGate: boolean;
  dmQuickReply?: boolean;
  /**
   * The opening as a CARD — cover, copy and a real postback — carried in the single private
   * reply Meta allows per comment. Verified on device 2026-08-24: a generic template is
   * accepted on that surface and renders with tappable buttons.
   *
   * Separate from `privateQuickReply` because they compete for the same one-shot reply and
   * only one can win. Card takes precedence when both are on: a chip posts its own label into
   * the thread as the parent's words, an in-bubble button does not.
   */
  privateGeneric?: boolean;
};

/**
 * Text only, and now an explicit choice rather than a default.
 *
 * This was the fallback for an absent `capabilities`, and that default cost the follow gate
 * its card twice: the dependency type that calls it simply had no such field, so nothing was
 * ever passed, TEXT_ONLY quietly won, and a gate holding a perfectly good cover sent plain
 * text. Nothing failed, so nothing surfaced — the shape a parent received was decided by an
 * omission.
 *
 * `capabilities` is required on every send below. A caller that wants text passes this and
 * says so; a caller that forgets no longer compiles.
 */
export const TEXT_ONLY_CAPABILITIES: GuideActionCapabilities = {
  privateQuickReply: false,
  dmGenericGate: false,
  dmQuickReply: false,
  privateGeneric: false,
};

function requiredOpaqueActionToken(value: string): string {
  const parsed = opaqueActionToken.safeParse(value);
  if (!parsed.success) throw new Error("invalid_guide_action_token");
  return parsed.data;
}

function sendCapabilityPayload(
  payload: GuideGateCapabilityPayload,
  metadata: Parameters<typeof sendMetaMessage>[1],
): Promise<MetaSendResult> {
  return sendMetaMessage(payload, metadata);
}

export async function sendGuideInitialPrivateReply(input: {
  commentId: string;
  guideName: string;
  actionToken: string;
  capabilities: GuideActionCapabilities;
  /** Square cover for the card. Absent means the card cannot be built, so text is used. */
  coverUrl?: string;
  /** Names the guide's category so the card's button says what it is sending. */
  categorySlug?: string;
}): Promise<MetaSendResult> {
  const { capabilities } = input;

  // The card first, because it is the richest shape this one reply can carry — and because a
  // quick reply would spend the same single reply on strictly less. Requires a cover: a card
  // with no image is a worse opening than the text it replaced, so a missing square falls
  // through rather than sending a hollow template.
  if (capabilities.privateGeneric && input.coverUrl) {
    const text = guideAccessOpening(input.guideName);
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "private_generic",
        commentId: input.commentId,
        title: guideAccessOpeningCardTitle,
        guideName: input.guideName,
        profileUrl: GUIDE_PROFILE_URL,
        coverUrl: input.coverUrl,
        actionToken: requiredOpaqueActionToken(input.actionToken),
        ...(input.categorySlug ? { categorySlug: input.categorySlug } : {}),
      }),
      { commentId: input.commentId, mode: "private_generic", messageLength: text.length },
    );
  }

  // Decide before sending. Never retry text after an attempted rich private reply.
  if (!capabilities.privateQuickReply) {
    // The text variant asks for a reply instead of naming a control, so it is a
    // different length. Measure the copy that is actually sent.
    const text = guideAccessOpeningText(input.guideName);
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "private_text",
        commentId: input.commentId,
        guideName: input.guideName,
      }),
      { commentId: input.commentId, mode: "private_text", messageLength: text.length },
    );
  }

  const text = guideAccessOpening(input.guideName);
  return sendCapabilityPayload(
    buildGuideGateCapabilityPayload({
      case: "private_quick_reply",
      commentId: input.commentId,
      guideName: input.guideName,
      actionToken: requiredOpaqueActionToken(input.actionToken),
    }),
    { commentId: input.commentId, mode: "private_quick_reply", messageLength: text.length },
  );
}

export async function sendGuideFollowerGate(input: {
  recipientId: string;
  guideName: string;
  /** The square cover. Empty means the gate cannot be a card and falls back to text. */
  coverUrl: string;
  actionToken: string;
  capabilities: GuideActionCapabilities;
  /**
   * Names the guide's category so the card's button can say what it is sending rather
   * than "Send it over". Optional, and absent degrades to the generic label — a button
   * whose wording is less specific is a cosmetic loss, and a copy lookup must never be
   * able to cost a parent their guide.
   */
  categorySlug?: string;
}): Promise<MetaSendResult> {
  const { capabilities } = input;

  if (capabilities.dmGenericGate && input.coverUrl) {
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "dm_generic_gate",
        recipientId: input.recipientId,
        title: guideAccessCardTitle,
        guideName: input.guideName,
        profileUrl: GUIDE_PROFILE_URL,
        coverUrl: input.coverUrl,
        actionToken: requiredOpaqueActionToken(input.actionToken),
        ...(input.categorySlug ? { categorySlug: input.categorySlug } : {}),
      }),
      { recipientId: input.recipientId, mode: "dm_generic_gate", messageLength: 0 },
    );
  }

  const text = `${guideAccessWaitingTitle(input.guideName)}\n\n${guideAccessCopy.nonFollowerGateText}\n\nVisit profile: ${GUIDE_PROFILE_URL}`;
  return sendMetaMessage(
    {
      recipient: { id: input.recipientId },
      messaging_type: "RESPONSE",
      message: { text },
    },
    { recipientId: input.recipientId, mode: "dm_text_gate", messageLength: text.length },
  );
}

export async function sendGuideFollowLag(input: {
  recipientId: string;
  actionToken: string;
  capabilities: GuideActionCapabilities;
}): Promise<MetaSendResult> {
  const { capabilities } = input;
  const actionToken = requiredOpaqueActionToken(input.actionToken);
  const text = capabilities.dmQuickReply
    ? guideAccessCopy.followLag
    : guideAccessCopy.followLagText;

  if (capabilities.dmQuickReply) {
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "dm_follow_lag",
        recipientId: input.recipientId,
        actionToken,
      }),
      {
        recipientId: input.recipientId,
        mode: "dm_quick_reply_follow_lag",
        messageLength: text.length,
      },
    );
  }

  return sendMetaMessage(
    {
      recipient: { id: input.recipientId },
      messaging_type: "RESPONSE",
      message: { text },
    },
    { recipientId: input.recipientId, mode: "dm_text_follow_lag", messageLength: text.length },
  );
}
