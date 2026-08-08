export interface WebhookEntry {
  id: string;
  time: number;
  changes?: ChangeEntry[];
  messaging?: MessagingEntry[];
}

export interface WebhookPayload {
  object: "instagram";
  entry: WebhookEntry[];
}

export interface ChangeEntry {
  field: "comments" | string;
  value: CommentValue;
}

export interface CommentValue {
  id: string;
  text: string;
  from?: { id: string; username?: string };
  media?: { id: string; media_product_type?: string };
  parent_id?: string;
}

export interface MessagingEntry {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; [key: string]: unknown };
    }>;
    /**
     * Story context, and the two cases are opposites.
     *
     * `mention` — they tagged us in THEIR story. Meta delivers it as an ordinary
     * inbound message with no text and NO attachments array, so without this
     * field it is indistinguishable from the person typing nothing at us.
     * Verified 2026-08-08 against the Graph API, which returned
     * `{"message":"","story":{"mention":{"link":""}}}` for such a mid.
     *
     * `reply_to` — they replied to OUR story, in their own words. That is a real
     * message and is treated as one.
     */
    story?: {
      mention?: { link?: string; [key: string]: unknown };
      reply_to?: { link?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
  };
  read?: { mid?: string; watermark?: number };
  reaction?: {
    mid?: string;
    action?: "react" | "unreact" | string;
    reaction?: string;
    emoji?: string;
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

export type AttachmentType = "image" | "video" | "audio" | "file";

/**
 * Meta's `message_id` for a send we just made. Null when the Graph response
 * omitted it — the send still succeeded, we simply cannot key the recorded row on
 * it, so idempotency for that row falls back to nothing rather than a wrong id.
 */
export interface MetaSendResult {
  messageId: string | null;
}
