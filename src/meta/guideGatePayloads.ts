import { z } from "zod";
import type { GuideCoverCategorySlug } from "../../shared/guideCoverRegistry.js";
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

/**
 * Two kinds of label, and they are NOT interchangeable.
 *
 * A quick reply's title is posted into the thread as the PARENT'S OWN MESSAGE when tapped.
 * So a chip label has to be something a parent would plausibly type — it ends up in their
 * sent history, attributed to them. A generic-template button is a `postback`: tapping it
 * sends nothing to the thread, so its label is pure interface and can carry personality.
 *
 * These were one set of constants, which meant the expressive slot was written to survive
 * the stricter job and both ended up flat. `confirmFollow` even carried a "✓" into what
 * became the parent's own outgoing message, which reads as a UI artifact in their words.
 *
 * Meta's guidance for any button title: keep it under 20 characters, one to three words,
 * and avoid punctuation. Asserted in the tests rather than trusted to review.
 */
export const GUIDE_GATE_BUTTON_LABELS = {
  /** Quick reply. Becomes the parent's own message, so it reads as something they'd say. */
  requestGuide: "Yes, send it",
  /** Quick reply. The "✓" was removed: it appeared inside the parent's own sent message. */
  confirmFollow: "I'm following",
  /** Link button on the card. */
  visitProfile: "Visit profile",
  /** Postback fallback, used when the caller cannot tell us the category. */
  cardAction: "Send it over",
} as const;

/**
 * The postback label, per category.
 *
 * The card already knows its category — it is rendering that category's kicker, palette and
 * illustration — so naming the thing being sent costs one lookup and makes each card read as
 * authored rather than templated. `bedtime` deliberately echoes its own kicker ("A TINY WIN
 * FOR TONIGHT") so the cover and the button read as one thought instead of artwork plus a
 * form.
 *
 * A missing category falls back to `cardAction` rather than throwing: an unlabelled button
 * is a cosmetic loss, and failing the send over copy would cost the parent their guide.
 */
export const GUIDE_GATE_CATEGORY_ACTION_LABELS: Record<GuideCoverCategorySlug, string> = {
  bedtime: "Send my tiny win",
  "potty-training": "Send the steps",
  recipes: "Send the recipes",
  "montessori-activities": "Send the activity",
};

export function guideGateCardActionLabel(categorySlug?: string): string {
  if (!categorySlug) return GUIDE_GATE_BUTTON_LABELS.cardAction;
  return (
    GUIDE_GATE_CATEGORY_ACTION_LABELS[categorySlug as GuideCoverCategorySlug] ??
    GUIDE_GATE_BUTTON_LABELS.cardAction
  );
}

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
    // Optional so an unknown category degrades to the generic label instead of rejecting
    // the payload. Not validated against the slug union here: the label resolver already
    // falls back, and a copy decision must never be able to block a guide.
    categorySlug: z.string().optional(),
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
    categorySlug: z.string().optional(),
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
              title: guideGateCardActionLabel(input.categorySlug),
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
              title: guideGateCardActionLabel(input.categorySlug),
              payload: actionPayload(input.actionToken),
            },
          ],
        }),
      };
  }
}
