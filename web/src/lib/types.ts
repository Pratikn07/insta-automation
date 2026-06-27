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

// Follow intel resolved from the IgUser profile lookup (only knowable once a user
// has DM'd us). null = not yet checked / couldn't resolve.
export interface FollowFields {
  isFollower?: boolean | null;
  followerCount?: number | null;
  isVerified?: boolean | null;
}

// Within the awaiting_done state, did the gate DM actually land? "retrying" means
// Instagram blocked the auto-DM and the worker is still re-attempting — so the
// ball is NOT in the user's court. "delivered" means they got it; we're waiting on
// them. null for non-awaiting states. Server-derived in the list endpoint.
export type DeliveryStatus = "delivered" | "retrying";

export interface Conversation extends FollowFields {
  id: string;
  igUserId: string;
  keywordId: string;
  state: ConversationState;
  delivery?: DeliveryStatus | null;
  createdAt: string;
  completedAt: string | null;
  keyword: { id: string; keyword: string };
  username?: string | null;
  name?: string | null;
}

export interface ConversationCounts {
  awaiting_done: number;
  completed: number;
  expired: number;
  retrying: number;
  waitingOnReply: number;
}

export interface Stats {
  activeKeywords: number;
  totalKeywords: number;
  dmsSentToday: number;
  conversationsAwaiting: number;
  completedToday: number;
  lastError: { kind: string; createdAt: string; payload: unknown } | null;
  gateQueuePending: number;
  gateQueueExhausted: number;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UserDirItem extends FollowFields {
  igUserId: string;
  username: string | null;
  name: string | null;
  lastActiveAt: string;
  conversationCount: number;
}

export interface LineageEvent {
  id: string;
  kind: string;
  createdAt: string;
  text: string | null;
  keyword: string | null;
  source: string | null;
  subcode: number | null;
  message: string | null;
  conversationId: string | null;
}

export interface UserLineageResponse {
  user: {
    igUserId: string;
    username: string | null;
    name: string | null;
    isFollower?: boolean | null;
    followerCount?: number | null;
    isVerified?: boolean | null;
    followCheckedAt?: string | null;
  };
  conversations: {
    id: string;
    state: ConversationState;
    createdAt: string;
    keyword: { id: string; keyword: string };
  }[];
  events: LineageEvent[];
}

export interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
}
