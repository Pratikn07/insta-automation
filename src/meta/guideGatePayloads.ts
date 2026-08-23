import { z } from "zod";
import {
  guideAccessCopy,
  guideAccessOpening,
  guideAccessOpeningText,
  guideAccessWaitingTitle,
} from "../services/guideAccessCopy.js";

export const GUIDE_GATE_CAPABILITY_CASES = [
  "private_text",
  "private_quick_reply",
  "private_generic",
  "dm_quick_reply",
  "dm_follow_lag",
  "dm_generic_gate",
] as const;

export type GuideGateCapabilityCase = (typeof GUIDE_GATE_CAPABILITY_CASES)[number];

export const GUIDE_GATE_BUTTON_LABELS = {
  requestGuide: "Yes, send it",
  visitProfile: "Visit profile",
  confirmFollow: "I'm following ✓",
} as const;

type QuickReply = {
  content_type: "text";
  title: string;
  payload: string;
};

type GenericButton =
  | { type: "web_url"; url: string; title: string }
  | { type: "postback"; title: string; payload: string };

type GenericElement = {
  title: string;
  subtitle: string;
  image_url: string;
  default_action: { type: "web_url"; url: string };
  buttons: GenericButton[];
};

export type GuideGateCapabilityPayload = {
  recipient: { comment_id: string } | { id: string };
  messaging_type?: "RESPONSE";
  message:
    | { text: string }
    | { text: string; quick_replies: QuickReply[] }
    | {
        attachment: {
          type: "template";
          payload: { template_type: "generic"; elements: GenericElement[] };
        };
      };
};

const providerId = z.string().regex(/^\d{1,32}$/);
const guideName = z.string().trim().min(1).max(56);
const actionToken = z.string().uuid();
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:");

const inputSchema = z.discriminatedUnion("case", [
  z.object({
    case: z.literal("private_text"),
    commentId: providerId,
    guideName,
  }),
  z.object({
    case: z.literal("private_quick_reply"),
    commentId: providerId,
    guideName,
    actionToken,
  }),
  z.object({
    case: z.literal("private_generic"),
    commentId: providerId,
    guideName,
    profileUrl: httpsUrl,
    coverUrl: httpsUrl,
    actionToken,
  }),
  z.object({
    case: z.literal("dm_quick_reply"),
    recipientId: providerId,
    guideName,
    actionToken,
  }),
  z.object({
    case: z.literal("dm_follow_lag"),
    recipientId: providerId,
    actionToken,
  }),
  z.object({
    case: z.literal("dm_generic_gate"),
    recipientId: providerId,
    guideName,
    profileUrl: httpsUrl,
    coverUrl: httpsUrl,
    actionToken,
  }),
]);

export type GuideGateCapabilityInput = z.output<typeof inputSchema>;

export function parseGuideGateCapabilityInput(rawInput: unknown): GuideGateCapabilityInput {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error("invalid_guide_gate_payload");
  return parsed.data;
}

function actionPayload(token: string): string {
  return `ts:guide:${token}`;
}

function quickReply(token: string): QuickReply {
  return {
    content_type: "text",
    title: GUIDE_GATE_BUTTON_LABELS.requestGuide,
    payload: actionPayload(token),
  };
}

function followQuickReply(token: string): QuickReply {
  return {
    content_type: "text",
    title: GUIDE_GATE_BUTTON_LABELS.confirmFollow,
    payload: actionPayload(token),
  };
}

function genericMessage(element: GenericElement): GuideGateCapabilityPayload["message"] {
  return {
    attachment: {
      type: "template",
      payload: { template_type: "generic", elements: [element] },
    },
  };
}

export function buildGuideGateCapabilityPayload(
  rawInput: unknown,
): GuideGateCapabilityPayload {
  const input = parseGuideGateCapabilityInput(rawInput);

  switch (input.case) {
    case "private_text": {
      // No control accompanies this message, so the copy must not name one.
      const text = guideAccessOpeningText(input.guideName);
      return {
        recipient: { comment_id: input.commentId },
        message: { text },
      };
    }
    case "private_quick_reply": {
      const text = guideAccessOpening(input.guideName);
      return {
        recipient: { comment_id: input.commentId },
        message: { text, quick_replies: [quickReply(input.actionToken)] },
      };
    }
    case "private_generic":
      return {
        recipient: { comment_id: input.commentId },
        message: genericMessage({
          title: `Your ${input.guideName} is ready`,
          subtitle: "Tap below and I'll check access before sending it here.",
          image_url: input.coverUrl,
          default_action: { type: "web_url", url: input.profileUrl },
          buttons: [
            {
              type: "postback",
              title: GUIDE_GATE_BUTTON_LABELS.requestGuide,
              payload: actionPayload(input.actionToken),
            },
          ],
        }),
      };
    case "dm_quick_reply": {
      const text = guideAccessOpening(input.guideName);
      return {
        recipient: { id: input.recipientId },
        messaging_type: "RESPONSE",
        message: { text, quick_replies: [quickReply(input.actionToken)] },
      };
    }
    case "dm_follow_lag":
      return {
        recipient: { id: input.recipientId },
        messaging_type: "RESPONSE",
        message: {
          text: guideAccessCopy.followLag,
          quick_replies: [followQuickReply(input.actionToken)],
        },
      };
    case "dm_generic_gate":
      return {
        recipient: { id: input.recipientId },
        messaging_type: "RESPONSE",
        message: genericMessage({
          title: guideAccessWaitingTitle(input.guideName),
          subtitle: guideAccessCopy.nonFollowerGate,
          image_url: input.coverUrl,
          default_action: { type: "web_url", url: input.profileUrl },
          buttons: [
            {
              type: "web_url",
              url: input.profileUrl,
              title: GUIDE_GATE_BUTTON_LABELS.visitProfile,
            },
            {
              type: "postback",
              title: GUIDE_GATE_BUTTON_LABELS.confirmFollow,
              payload: actionPayload(input.actionToken),
            },
          ],
        }),
      };
  }
}
