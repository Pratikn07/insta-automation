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

export interface FollowConversion {
  windowDays: number;
  deliveredToNonFollowers: number;
  rechecked: number;
  converted: number;
  pending: number;
  yieldPct: number | null;
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
