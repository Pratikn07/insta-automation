export type MessageType = "text" | "image" | "pdf";
export type ConversationState = "awaiting_done" | "completed" | "expired";

export interface Resource {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count?: { messages: number; keywords: number };
}

export interface ResourceMessage {
  id: string;
  resourceId: string;
  order: number;
  type: MessageType;
  body: string | null;
  mediaUrl: string | null;
}

export interface ResourceWithMessages extends Resource {
  messages: ResourceMessage[];
  keywords: { id: string; keyword: string }[];
}

export interface Keyword {
  id: string;
  keyword: string;
  mediaId: string | null;
  mediaCaption: string | null;
  mediaPermalink: string | null;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  resource?: { id: string; name: string; _count: { messages: number } };
  _count?: { conversations: number };
}

export interface Reel {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

export interface ReelsPage {
  items: Reel[];
  nextCursor: string | null;
}

export interface Conversation {
  id: string;
  igUserId: string;
  keywordId: string;
  state: ConversationState;
  createdAt: string;
  completedAt: string | null;
  keyword: { id: string; keyword: string };
}

export interface Stats {
  activeKeywords: number;
  totalKeywords: number;
  dmsSentToday: number;
  conversationsAwaiting: number;
  completedToday: number;
  lastError: { kind: string; createdAt: string; payload: unknown } | null;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
}
