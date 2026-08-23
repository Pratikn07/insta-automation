import { z } from "zod";
import {
  buildGuideGateCapabilityPayload,
  type GuideGateCapabilityPayload,
} from "./guideGatePayloads.js";
import { sendMetaMessage } from "./sendMessage.js";
import {
  guideAccessCopy,
  guideAccessOpening,
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
};

const TEXT_ONLY_CAPABILITIES: GuideActionCapabilities = {
  privateQuickReply: false,
  dmGenericGate: false,
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
  capabilities?: GuideActionCapabilities;
}): Promise<MetaSendResult> {
  const capabilities = input.capabilities ?? TEXT_ONLY_CAPABILITIES;
  const text = guideAccessOpening(input.guideName);

  // Decide before sending. Never retry text after an attempted rich private reply.
  if (!capabilities.privateQuickReply) {
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "private_text",
        commentId: input.commentId,
        guideName: input.guideName,
      }),
      { commentId: input.commentId, mode: "private_text", messageLength: text.length },
    );
  }

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
  coverUrl: string;
  actionToken: string;
  capabilities?: GuideActionCapabilities;
}): Promise<MetaSendResult> {
  const capabilities = input.capabilities ?? TEXT_ONLY_CAPABILITIES;

  if (capabilities.dmGenericGate) {
    return sendCapabilityPayload(
      buildGuideGateCapabilityPayload({
        case: "dm_generic_gate",
        recipientId: input.recipientId,
        guideName: input.guideName,
        profileUrl: GUIDE_PROFILE_URL,
        coverUrl: input.coverUrl,
        actionToken: requiredOpaqueActionToken(input.actionToken),
      }),
      { recipientId: input.recipientId, mode: "dm_generic_gate", messageLength: 0 },
    );
  }

  const text = `${guideAccessWaitingTitle(input.guideName)}\n\n${guideAccessCopy.nonFollowerGate}\n\nVisit profile: ${GUIDE_PROFILE_URL}`;
  return sendMetaMessage(
    {
      recipient: { id: input.recipientId },
      messaging_type: "RESPONSE",
      message: { text },
    },
    { recipientId: input.recipientId, mode: "dm_text_gate", messageLength: text.length },
  );
}
