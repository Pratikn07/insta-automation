// src/meta/linkGuidePayloads.ts
import type { MetaMessagePayload } from "./sendMessage.js";
import { IG_TEXT_CHAR_LIMIT } from "../lib/instagramLimits.js";
import {
  codePoints,
  LINK_BUTTON_LABEL_MAX,
  LINK_CARD_TEXT_MAX,
} from "../services/linkGuidePolicy.js";

/** 16 characters, inside Meta's 20-character button limit. */
export const LINK_GUIDE_FOLLOW_BUTTON_LABEL = "Follow @tinysoho";

export type LinkGuideRecipient = { comment_id: string } | { id: string };

type WebUrlButton = { type: "web_url"; url: string; title: string };

function invalid(): never {
  throw new Error("invalid_link_guide_payload");
}

function text(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || codePoints(trimmed) > max) invalid();
  return trimmed;
}

function https(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.protocol !== "https:") invalid();
  return value;
}

/** Private replies address a comment and carry no messaging_type, like sendPrivateReply. */
function envelope(recipient: LinkGuideRecipient): Omit<MetaMessagePayload, "message"> {
  return "comment_id" in recipient ? { recipient } : { recipient, messaging_type: "RESPONSE" };
}

export function buildLinkGuideCardPayload(input: {
  recipient: LinkGuideRecipient;
  title: string;
  subtitle: string;
  coverUrl: string;
  buttonLabel: string;
  trackedUrl: string;
  profileUrl: string;
}): MetaMessagePayload {
  const trackedUrl = https(input.trackedUrl);
  const buttons: WebUrlButton[] = [
    { type: "web_url", url: trackedUrl, title: text(input.buttonLabel, LINK_BUTTON_LABEL_MAX) },
    { type: "web_url", url: https(input.profileUrl), title: LINK_GUIDE_FOLLOW_BUTTON_LABEL },
  ];
  return {
    ...envelope(input.recipient),
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: text(input.title, LINK_CARD_TEXT_MAX),
              subtitle: text(input.subtitle, LINK_CARD_TEXT_MAX),
              image_url: https(input.coverUrl),
              default_action: { type: "web_url", url: trackedUrl },
              buttons,
            },
          ],
        },
      },
    },
  };
}

export function buildLinkGuideTextPayload(input: {
  recipient: LinkGuideRecipient;
  text: string;
}): MetaMessagePayload {
  return { ...envelope(input.recipient), message: { text: text(input.text, IG_TEXT_CHAR_LIMIT) } };
}
