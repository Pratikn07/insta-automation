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
  };
}

export type AttachmentType = "image" | "video" | "audio" | "file";
