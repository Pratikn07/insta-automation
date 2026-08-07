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
