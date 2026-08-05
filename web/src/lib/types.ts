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
  // null only on the legacy global keywords — new ones always belong to a post.
  mediaId: string | null;
  mediaCaption: string | null;
  mediaPermalink: string | null;
  // The POST's publish date, snapshotted at attach time. Ranks candidates when a
  // cold DM must choose between several posts sharing a word. Null on globals.
  mediaPostedAt: string | null;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  resource?: { id: string; name: string; _count: { messages: number } };
  _count?: { conversations: number };
}

// Mirrors src/meta/fetchMedia.ts. Only these two kinds exist on the account
// (114 reels + 33 feed carousels); a single-image feed post would arrive as
// "carousel", which is correct for keyword attachment.
export type MediaKind = "reel" | "carousel";

/** One post from /api/media/content — a reel or a carousel. */
export interface MediaItem {
  id: string;
  kind: MediaKind;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

export interface MediaPage {
  items: MediaItem[];
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

export interface FollowConversion {
  windowDays: number;
  deliveredToNonFollowers: number;
  rechecked: number;
  converted: number;
  pending: number;
  yieldPct: number | null;
  // Follow-THROUGH: of the converts, how many were still following when
  // re-measured weeks later. Keeps yieldPct honest — one reading taken days
  // after delivery cannot tell a real follower from a freebie grab.
  followThroughDays: number;
  followThroughChecked: number;
  stillFollowing: number;
  unfollowed: number;
  retentionPct: number | null; // null when the sample is too small to report
}

// Mirrors src/meta/tokenStoreCore.ts. The Instagram token's countdown — the
// refresh worker should hold this at "healthy" forever, so anything else means
// the worker has stopped and a manual re-mint is coming.
export interface TokenHealth {
  daysUntilExpiry: number;
  expiresAt: string;
  lastRefreshedAt: string;
  status: "healthy" | "warning" | "critical" | "expired";
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
  followConversion?: FollowConversion;
  tokenHealth?: TokenHealth | null;
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

// --- Insights ---
export interface ConversionLine {
  keywordComments: number;
  gateDelivered: number;
  completed: number;
}

export interface LeaderboardRow {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  usFitScore: number | null;
  confidence: string | null;
  mediaAudioType: string | null;
  videoUnavailable: boolean;
  analyzed: boolean;
  views: number | null;
  reach: number | null;
  skipRate: number | null;
  conversion: ConversionLine;
  // Share of reach that entered the funnel (keywordComments ÷ reach, %). Null
  // below the backend reach floor — too small a denominator to trust.
  captureRatePct: number | null;
}

export interface ContentProfile {
  transcript: string;
  onScreenText: string;
  onScreenLang: string;
  speakerAccent: string;
  accentConfidence: number;
  visualSetting: string;
  culturalReferences: Array<{ text: string; region: string }>;
  hookArchetype: string;
  audioVibe: string;
  usCulturalFitRationale: string;
  accentScore: number;
  settingScore: number;
  culturalScore: number;
}

export interface ReelInsightDetail {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  usFitScore: number | null;
  confidence: string | null;
  mediaAudioType: string | null;
  manualAudioType: string | null;
  manualLangOverride: string | null;
  manualNote: string | null;
  videoUnavailable: boolean;
  contentProfile:
    | (ContentProfile & {
        source: string;
        promptVersion: string;
        modelId: string;
        costUsd: number | null;
      })
    | null;
  latestPerf: {
    views: number | null;
    reach: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saved: number | null;
    totalInteractions: number | null;
    avgWatchTimeMs: number | null;
    skipRate: number | null;
    capturedAt: string;
  } | null;
  conversion: ConversionLine;
}

export interface GeoStageSplit {
  stage: "follower" | "engaged" | "reached";
  usPct: number | null;
  inPct: number | null;
  totalCounted: number | null;
  counts: Record<string, number>;
  capturedAt: string | null;
}

export interface RecipeReference {
  text: string;
  count: number;
}

export interface RecipeGroup {
  label: string;
  reels: LeaderboardRow[];
  usRefs: RecipeReference[];
  indiaRefs: RecipeReference[];
  avgUsFit: number | null;
  avgSettingScore: number | null;
  avgCulturalScore: number | null;
  // Median (not mean) reach — mean is meaningless here due to viral outliers.
  medianReach: number | null;
}

export interface RecipeData {
  ready: boolean;
  scoredCount: number;
  top: RecipeGroup | null;
  bottom: RecipeGroup | null;
  checklist: string[];
  // usFit↔reach correlation across all scored reels (≈0 → US-fit ≠ reach).
  usFitReachCorr: number | null;
}

// Per-reel inferred origin of KEYWORD-COMMENTERS (a name-proxy, gate-crowd only).
export interface ReelOriginRow {
  mediaId: string;
  caption: string | null;
  usFitScore: number | null;
  total: number;
  usWestern: number;
  southAsian: number;
  other: number;
  unknown: number;
  followers: number;
}

export interface Experiment {
  id: string;
  hypothesis: string;
  variable: string;
  reelMediaIds: string[];
  status: "running" | "inconclusive" | "confirmed" | "busted";
  baselineUsPct: number | null;
  measuredUsPct: number | null;
  currentUsPct: number | null;
  startedAt: string;
  postedAt: string | null;
  conclusion: string | null;
  // Auto-experiment fields (origin "manual" for hand-created ones).
  origin: "manual" | "auto";
  mediaId: string | null;
  usFitScore: number | null;
  culturalCues: string[];
  baselineEngagedUsPct: number | null;
  measuredEngagedUsPct: number | null;
  windowReachShare: number | null;
  suggestedVerdict: "confirmed" | "busted" | "inconclusive" | null;
  attributionConfidence: "high" | "medium" | "low" | null;
  // Content features from the reel's Gemini profile (null for manual/unprofiled).
  hookArchetype: string | null;
  audioVibe: string | null;
  onScreenLang: string | null;
}

export interface UsReachTrendPoint {
  capturedAt: string;
  usPct: number | null;
}

// 14d ("recent reels" thermometer) vs 90d (baseline) US%, reached + engaged.
export interface GeoWindowPoint {
  capturedAt: string;
  reachedUs90: number | null;
  reachedUs14: number | null;
  engagedUs90: number | null;
  engagedUs14: number | null;
  reachedIn14: number | null;
  engagedIn14: number | null;
}

// ── Follower flow (daily net adds by region) ─────────────────────────────────
// Mirrors src/services/followerFlowCore.ts. Diffed from Meta's cumulative
// follower_demographics; nulls mean "unknown" (gap/stale), never zero.

export type DailyAddsBasis =
  | "diff"
  | "multi_day_span" // real diff absorbing prior stale/missing days
  | "stale" // Meta didn't refresh; adds absorbed by a later point
  | "no_snapshot"
  | "no_prior_day"
  | "pending"; // trailing stale day, no later real diff yet

// Mirrors src/services/followerFlowCore.ts. A reel that gained notable reach
// while a spike happened — a CANDIDATE, never a cause. Meta gives no per-reel
// follower attribution, so this is reach-timing correlation only.
export interface SpikeCandidateInfo {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  reachGained: number;
  sharePct: number;
}

export interface SpikeInfo {
  multiple: number; // net / trailing median, e.g. 4.4
  net: number;
  baselineMedian: number;
  confidence: "high" | "medium" | "low"; // low = several reels overlapped
  candidates: SpikeCandidateInfo[]; // at most 3, largest reach gain first
}

export interface FollowerDailyAddsPoint {
  day: string; // UTC calendar day, "2026-07-21"
  capturedAt: string | null;
  us: number | null;
  southAsian: number | null;
  anglosphere: number | null;
  other: number | null;
  total: number | null;
  unattributed: number | null; // Meta top-45 rank-churn residual, not a region
  reportedTotalDelta: number | null;
  spanDays: number | null; // calendar days this diff covers (>1 absorbs gaps)
  stale: boolean;
  provisional: boolean; // within Meta's ~48h demographics lag, may still shift
  basis: DailyAddsBasis;
  // Present only on days that cleared the spike thresholds; absent is normal.
  spike?: SpikeInfo;
}

export interface FollowerStock {
  capturedAt: string;
  totalCounted: number; // sum across Meta's reported countries, NOT true total
  // Instagram's real profile count (followers_count); null if the fetch failed.
  // Exceeds totalCounted by the followers in countries below Meta's ~45-country
  // reporting cutoff.
  followersTotal: number | null;
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  countriesReported: number;
}

export interface FollowerFlowResponse {
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
}

// --- AI (ChatGPT connection) -------------------------------------------------
// Mirrors the runtime's ConnectionStatus exactly. Nulls are meaningful: a null
// `rateLimits` means "usage unknown", never "0% used", and a null email means the
// account exposed no address — neither may be rendered as a real value.
export interface AiConnectionStatus {
  connected: boolean;
  requiresOpenaiAuth: boolean;
  account: null | { email: string | null; planType: string };
  rateLimits: null | { usedPercent: number | null; resetsAt: number | null };
}

// Device-code display fields only. There is deliberately no token field here —
// ChatGPT credentials never leave the runtime's volume.
export interface AiLoginStart {
  loginId: string;
  userCode: string;
  verificationUrl: string;
}

// --- DM threads + AI reply drafts --------------------------------------------
export type ReplyDraftStatus =
  | "queued"
  | "generating"
  | "pending_approval"
  | "generation_failed"
  | "dismissed"
  | "superseded"
  | "sending"
  | "sent"
  | "send_failed"
  | "send_uncertain";

export type DmDirection = "inbound" | "outbound";
export type DmMessageType = "text" | "image" | "video" | "audio" | "file" | "unknown";

export interface DmMessage {
  id: string;
  direction: DmDirection;
  text: string | null;
  type: DmMessageType;
  source: string;
  mediaUrl: string | null;
  instagramTimestamp: string;
}

export interface ReplyDraft {
  id: string;
  status: ReplyDraftStatus;
  revision: number;
  // The model's original output. Never rewritten — this is the audit record.
  suggestedText: string | null;
  // The owner's editable copy, and what Approve & Send actually submits.
  workingText: string | null;
  approvedText: string | null;
  rationale: string | null;
  confidence: string | null;
  warnings: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  retryAt: string | null;
  // Which inbound this answers. If the thread has moved on, the draft is stale.
  inboundMessageId: string;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface DmThreadRow {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  needsReply: boolean;
  latestInboundMessageId: string | null;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  latestMessage: Omit<DmMessage, "id" | "mediaUrl"> | null;
  draft: ReplyDraft | null;
}

export interface DmThreadDetail {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  needsReply: boolean;
  latestInboundMessageId: string | null;
  lastMessageAt: string;
  messages: DmMessage[];
  draft: ReplyDraft | null;
}
