import type { MessagingEntry } from "../../types/meta.js";

export const GUIDE_ACTION_TOKEN = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
export const GUIDE_ACTION_PAYLOAD = `ts:guide:${GUIDE_ACTION_TOKEN}`;
export const GUIDE_ACTION_TIMESTAMP = 1787448600000;

export function guideQuickReplyEvent(): MessagingEntry {
  return {
    sender: { id: "controlled-recipient" },
    recipient: { id: "controlled-business" },
    timestamp: GUIDE_ACTION_TIMESTAMP,
    message: {
      mid: "controlled-quick-reply-mid",
      text: "Yes, send it",
      quick_reply: { payload: GUIDE_ACTION_PAYLOAD },
    },
  };
}

export function guidePostbackEvent(): MessagingEntry {
  return {
    sender: { id: "controlled-recipient" },
    recipient: { id: "controlled-business" },
    timestamp: GUIDE_ACTION_TIMESTAMP,
    postback: {
      mid: "controlled-template-mid",
      title: "I'm following ✓",
      payload: GUIDE_ACTION_PAYLOAD,
    },
  };
}

export function unknownPostbackEvent(): MessagingEntry {
  return {
    sender: { id: "controlled-recipient" },
    recipient: { id: "controlled-business" },
    timestamp: GUIDE_ACTION_TIMESTAMP,
    postback: {
      mid: "controlled-unknown-mid",
      title: "Unknown action",
      payload: "unregistered:action:value",
    },
  };
}
