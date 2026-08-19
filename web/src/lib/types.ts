export type MessageType = "text" | "image" | "pdf";
export type ConversationState = "awaiting_done" | "completed" | "expired";

export interface Resource {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count?: { messages: number; keywords: number };
  invalidMessageCount?: number;
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

export type UpcomingAutomationStatus =
  | "waiting"
  | "bound"
  | "needs_attention"
  | "cancelled";

export interface UpcomingAutomation {
  id: string;
  triggerWord: string;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
  status: UpcomingAutomationStatus;
  matchedMediaId: string | null;
  keywordId: string | null;
  errorCode: string | null;
  createdBy: string;
  lastAttemptAt: string | null;
  retriedAt: string | null;
  boundAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  resource: { id: string; name: string; _count: { messages: number } };
}

export interface UpcomingAutomationsResponse {
  automations: UpcomingAutomation[];
  discoveryEnabled: boolean;
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
  recovery?: ConversationRecoverySummary | null;
  readTracking?: ReadTrackingAvailability;
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
  historyRole?: "unreconciled" | "canonical" | "alias";
  canonicalOwner?: { id: string } | null;
  canonicalConversationId?: string | null;
  aliasCount?: number;
  reconciliationReason?: string | null;
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
  /**
   * Gate sends with an ambiguous outcome. Never auto-retried — the DM may
   * already have landed — so each one is a person who may never have received
   * their gate. Optional because an older API build omits it.
   */
  gateQueueSendUncertain?: number;
  /**
   * Upcoming setups whose post published but whose caption didn't match, so
   * nothing is attached. An ongoing outage rather than a historical one — the post
   * is live and every commenter gets nothing until it is fixed.
   *
   * Optional for the same reason as the field above: an older API build omits it,
   * and a missing count must read as "not measured", never as zero.
   */
  upcomingNeedsAttention?: number;
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
  day: string; // Pacific analytics calendar day, "2026-07-21"
  capturedAt: string | null;
  us: number | null;
  southAsian: number | null;
  anglosphere: number | null;
  other: number | null;
  total: number | null;
  unattributed: number | null; // Meta top-45 rank-churn residual, not a region
  // Per-country deltas behind the region roll-up, for the chart's country mode.
  // Contains ONLY countries Meta reported on both sides of the diff, so a country
  // crossing the top-45 cutoff is absent rather than zero — its movement is
  // unknown and lives in `unattributed`. Σ byCountry === total.
  // Optional: a browser may be talking to a server deployed before this field
  // existed, in which case country mode is unavailable rather than empty.
  byCountry?: Record<string, number> | null;
  reportedTotalDelta: number | null;
  spanDays: number | null; // calendar days this diff covers (>1 absorbs gaps)
  stale: boolean;
  provisional: boolean; // within Meta's ~48h demographics lag, may still shift
  basis: DailyAddsBasis;
  // --- exact-total anchoring (followerAllocationCore) --------------------------
  // Optional for the same reason as byCountry: a browser may be talking to a
  // server deployed before followers_count was being captured, and a day before
  // that capture began has no exact figure at all.
  //
  // The day's TRUE net adds, from the followers_count profile field. Unlike
  // `total` this has no top-45 country cutoff and no ~48h lag — it is the number
  // Instagram itself shows. When present, `total` has been anchored to it.
  exactTotal?: number | null;
  // What follower_demographics alone reported, before apportioning. Null on days
  // Meta never reported. Kept so the gap between measurement and estimate stays
  // inspectable rather than hidden.
  measuredTotal?: number | null;
  // The country/region split on this day was apportioned from a multi-day
  // demographic diff and/or rescaled onto the exact total, rather than being a
  // clean single-day Meta measurement. Meta publishes no per-country-per-day
  // follower data, so this is set on essentially every recent day — it marks
  // inference, not error.
  estimated?: boolean;
  // --- churn (follows_and_unfollows) -----------------------------------------
  // Meta's own daily ledger, present only for the days it answers. `total` is
  // NET, so a day that gained 400 and lost 380 is indistinguishable from one
  // that gained 20 without these. Null means Meta gave no figure — never zero,
  // which would read as "nobody unfollowed".
  follows?: number | null;
  unfollows?: number | null;
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
  analyticsTimeZone: "America/Los_Angeles";
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

export interface AiCapabilities {
  draftsEnabled: boolean;
  followUpsEnabled: boolean;
  sendEnabled: boolean;
}

// --- DM threads + AI reply drafts --------------------------------------------
export type ReplyDraftKind = "reply" | "engagement_follow_up";
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
  | "send_uncertain"
  | "expired";

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
  kind: ReplyDraftKind;
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
  sourceConversationId: string | null;
  eligibleAt: string;
  expiresAt: string | null;
  promptVersion: number | null;
  /** Server-authoritative comparison against the currently deployable policy. */
  promptPolicyCurrent: boolean;
  sourceGuide: {
    name: string;
    description: string | null;
    kind: string | null;
    keyword: string;
  } | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

// --- guide delivery owner review ---------------------------------------------
// A delivery the automation could not finish on its own. The server deliberately
// serialises identity and progress only: no text snapshot, media URL, provider
// body, or trace ID crosses this boundary, because the owner decides from
// position and status alone.
export type GuideDeliveryReviewUnitKind = "text" | "image" | "file";

export type GuideDeliveryReviewUnitStatus =
  | "pending"
  | "sending"
  | "sent"
  | "retryable"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface GuideDeliveryReviewUnit {
  id: string;
  /** Zero-based on the wire; rendered one-based so the owner counts messages. */
  position: number;
  kind: GuideDeliveryReviewUnitKind;
  status: GuideDeliveryReviewUnitStatus;
}

export interface GuideDeliveryReview {
  id: string;
  status: "needs_review" | "failed";
  confirmedUnits: number;
  totalUnits: number;
  sendWindowExpiresAt: string;
  /** Server-computed against its own clock, never re-derived in the browser. */
  sendWindowOpen: boolean;
  failureCode: string | null;
  units: GuideDeliveryReviewUnit[];
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
  /** Deliveries awaiting an owner decision. Independent of draft status. */
  deliveryReviewCount: number;
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
  deliveryReviews: GuideDeliveryReview[];
}

// --- AI advisor ---------------------------------------------------------------
// The advisor's navigation targets are a closed set on the server too, so the
// browser can render these as links without sanitising an arbitrary URL.
export type AdvisorHref = "/conversations" | "/insights" | "/keywords" | "/sequences";

export interface AdvisorEvidence {
  label: string;
  value: string;
  href: AdvisorHref | null;
}

export interface AdvisorResponse {
  answer: string;
  // Always present: an advisor that reports numbers without saying what to do
  // leaves the decision exactly where it was.
  recommendation: string;
  evidence: AdvisorEvidence[];
  confidence: "low" | "medium" | "high";
  nextStep: string;
  nextStepHref: AdvisorHref | null;
  // What the answer could not measure. Stated rather than silently omitted.
  dataGaps: string[];
}

export interface AdvisorHistoryItem {
  role: "user" | "assistant";
  clientMessageId: string | null;
  text: string | null;
  response: AdvisorResponse | null;
}

// ── Feed-post follow attribution ─────────────────────────────────────────────
// Mirrors src/services/feedFollowAttributionCore.ts and
// src/services/feedFollowAttributionService.ts. These counts cover regular
// FEED media only; Reels and Stories are not part of this response.

export type FeedFollowCollectionStatus = "not_started" | "complete" | "partial" | "missing";

export type FeedFollowComparisonReason =
  | "feed_not_started"
  | "feed_tracking_partial_day"
  | "feed_collection_incomplete"
  | "feed_multi_day_delta"
  | "feed_counter_correction"
  | "account_missing"
  | "account_provisional"
  | "account_not_one_day";

export interface FeedFollowAttributedPost {
  mediaId: string;
  mediaType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: string | null;
  follows: number;
  delta: number;
  spanDays: number;
}

export interface FeedFollowAttributionDay {
  day: string;
  collectionStatus: FeedFollowCollectionStatus;
  eligiblePosts: number;
  successfulPosts: number;
  unavailablePosts: number;
  failedPosts: number;
  missingPosts: number;
  attributedFeedFollows: number | null;
  posts: FeedFollowAttributedPost[];
  hasCounterCorrection: boolean;
  hasMultiDayDelta: boolean;
  accountNetAdds: number | null;
  accountBasis: DailyAddsBasis | null;
  accountProvisional: boolean;
  netResidualAfterFeed: number | null;
  comparisonReason: FeedFollowComparisonReason | null;
}

export interface FeedFollowAttributionResponse {
  range: { from: string; to: string };
  tracking: {
    startedAt: string | null;
    lastAttemptAt: string | null;
    lastCompletedAt: string | null;
    lastStatus: string | null;
    eligibleCount: number;
    writtenCount: number;
    unavailableCount: number;
    failedCount: number;
    lastError: string | null;
    trackedPosts: number;
    latestSnapshotDay: string | null;
  };
  days: FeedFollowAttributionDay[];
  summary: {
    comparableDays: number;
    attributedFeedFollows: number;
    accountNetAdds: number;
    netResidualAfterFeed: number;
  };
  caveats: string[];
}

// ── DM recovery ───────────────────────────────────────────────────────────
//
// Closed unions mirroring the backend. The dashboard must never invent a state
// the server cannot produce, and must never describe missing telemetry as
// "Unread" — Meta provides no such signal.

export type RecoveryStatus =
  | "waiting"
  | "control"
  | "suppressed"
  | "sending"
  | "sent"
  | "send_failed"
  | "send_uncertain"
  | "tracking_unavailable"
  | "cancelled";

export type RecoveryCohort = "treatment" | "control" | "not_applicable";
export type RecoveryTriggerKind = "no_confirmed_read" | "settings_blocked";
export type RecoverySettingsEvidenceStatus = "current" | "stale" | "retired" | "missing";

export interface RecoverySettingsEvidence {
  status: RecoverySettingsEvidenceStatus;
  verificationId: string | null;
  version: string | null;
  graphCode: number | null;
  graphSubcode: number | null;
  classifiedAt: string | null;
  verifiedAt: string | null;
  validUntil: string | null;
  apiVersion: string | null;
  evidenceReference: string | null;
  evidenceSha256: string | null;
}

export type SettingsBlockedVerificationStatus = "current" | "stale" | "retired" | "inactive";

export interface SettingsBlockedVerificationRecord {
  id: string;
  version: string;
  graphCode: number;
  graphSubcode: number;
  status: SettingsBlockedVerificationStatus;
  verifiedAt: string;
  validUntil: string;
  apiVersion: string;
  evidenceReference: string;
  evidenceSha256: string;
  active: boolean;
  retiredAt: string | null;
  retirementReason: string | null;
}

export type RecoveryView =
  | "all"
  | "scheduled"
  | "ready"
  | "sent"
  | "suppressed"
  | "control"
  | "attention";

export interface RecoveryReminderRow {
  id: string;
  conversationId: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  keyword: { id: string; keyword: string };
  media: { id: string | null; permalink: string | null; caption: string | null };
  triggerKind: RecoveryTriggerKind;
  status: RecoveryStatus;
  cohort: RecoveryCohort;
  acceptedAt: string | null;
  eligibleAt: string;
  seenAt: string | null;
  engagedAt: string | null;
  firstEngagementKind: string | null;
  suppressionReason: string | null;
  sentAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastErrorCategory: string | null;
  reviewedAt: string | null;
  createdAt: string;
  settingsEvidence: RecoverySettingsEvidence | null;
}

export interface RecoveryTimelineEntry {
  kind: string;
  at: string;
  detail?: string | null;
}

export interface RecoveryReminderDetail extends RecoveryReminderRow {
  commentId: string;
  keywordSnapshot: string;
  templateVersion: string;
  publicReplyId: string | null;
  trackingAvailable: boolean;
  comment: { text: string | null; receivedAt: string } | null;
  timeline: RecoveryTimelineEntry[];
}

export type RecoveryCountEntry = { records: number; people: number };
export type RecoveryCounts = Record<RecoveryView, RecoveryCountEntry>;

export interface RecoveryHealthSnapshot {
  circuitOpen: boolean;
  reason: string | null;
  openedAt: string | null;
  dueCount: number;
  sentLastHour: number;
  recentOutcomeCount: number;
  recentFailureRate: number | null;
  acceptedSignalSample: number;
  positiveSignalSample: number;
}

export interface RecoveryCohortSummary {
  eligiblePeople: number;
  eligibleJourneys: number;
  repliedWithin24h: number;
  repliedWithin48h: number;
  completedWithin24h: number;
  completedWithin48h: number;
  completionRate48h: number | null;
}

export interface RecoveryMetrics {
  experiment: {
    version: string;
    startAt: string | null;
    endAt: string | null;
    treatment: RecoveryCohortSummary & { sent: number };
    control: RecoveryCohortSummary & { withheld: number };
    absoluteLiftPercentagePoints: number | null;
    relativeLiftPercent: number | null;
    medianReminderToReplyMinutes: number | null;
    byKeyword: Array<{
      keywordId: string;
      keyword: string;
      treatmentEligiblePeople: number;
      treatmentCompletedWithin48h: number;
      controlEligiblePeople: number;
      controlCompletedWithin48h: number;
    }>;
  };
  accuracy: {
    eventualRepliers: number;
    eventualRepliersWithPriorSeen: number;
    readEventCoverage: number | null;
    sent: number;
    laterSeen: number;
    laterEngaged: number;
    laterCompleted: number;
    delayedPreSendSignalFalsePositives: number;
    withoutLaterPositiveEvidence: number;
    uncertain: number;
    duplicateAttempts: number;
    cooldownSuppressions: number;
    staleLeases: number;
    failed: number;
    settingsClassifierMatches: number;
  };
  settingsEvidence: {
    current: number;
    stale: number;
    retired: number;
    missing: number;
    byVerification: Array<{
      version: string | null;
      graphCode: number | null;
      graphSubcode: number | null;
      evidenceStatus: RecoverySettingsEvidenceStatus;
      ageDays: number | null;
      count: number;
      people: number;
      byReminderStatus: Partial<Record<RecoveryStatus, number>>;
    }>;
  };
  health: RecoveryHealthSnapshot;
}

/** The bounded badge attached to each Conversations row by Task 14. */
export interface ConversationRecoverySummary {
  id: string;
  status: RecoveryStatus;
  triggerKind: RecoveryTriggerKind;
  eligibleAt: string;
  sentAt: string | null;
}

/**
 * Why a journey has no read information. Never inferred from conversation
 * state: a journey from before launch has no recovery row for the same reason
 * an ineligible one does.
 */
export type ReadTrackingAvailability = "tracked" | "predates_tracking" | "not_available";

// ── Funnels ───────────────────────────────────────────────────────────────
// Mirrors src/services/funnels/{types,guideFollowFunnel,dropOff}.ts. Field
// names are kept identical so the two can be diffed by eye — every percentage
// on the page is computed server-side by summarizeGuideFollow, never here.

/**
 * A rate that refuses to lie about its own sample. `pct` is null below the
 * funnel's minSample; render the counts instead. "15.6%" over 32 people and
 * over 3,200 are different claims and only one of them is a number.
 */
export interface GuardedRate {
  numerator: number;
  denominator: number;
  pct: number | null;
  belowMinSample: boolean;
}

export interface FunnelStageCount {
  key: string;
  label: string;
  /** What counts and what does NOT. Surfaced on hover. */
  definition: string;
  /**
   * People reach this stage without passing the one before it, so no step
   * conversion is meaningful — it can exceed 100%. Someone already following
   * skips the gate and the reply entirely.
   */
  bypassable?: boolean;
  /**
   * The gap to the previous stage is measurement coverage, not attrition, so
   * no loss may be reported against it. Without this the 21-day stage renders
   * "1,395 lost here" directly above a caveat saying the number is coverage
   * and not churn.
   */
  coverageOnly?: boolean;
  count: number;
  ofEntryPct: number | null;
  ofPrevPct: number | null;
}

export interface FunnelHeadline {
  fromStage: string;
  toStage: string;
  label: string;
  rationale: string;
  rate: GuardedRate;
}

export interface FunnelEntryPathBreakdown {
  entryPath: string;
  entered: number;
  guideDelivered: number;
  deliveryRate: GuardedRate;
}

export interface GuideFollowResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  cohortSize: number;
  stages: FunnelStageCount[];
  headline: FunnelHeadline;
  followGateConversion: GuardedRate;
  stuckAtWall: number;
  askDistribution: { asks: number; conversations: number; cleared: number }[];
  expressLane: number;
  byEntryPath: FunnelEntryPathBreakdown[];
  retention: GuardedRate;
  homeTileCohort: { deliveredToNonFollower: number; ofWhichRedelivery: number };
}

export type DropOffBucket = "no-reply" | "stuck-at-wall";

export interface DropOffRow {
  conversationId: string;
  igUserId: string;
  username: string | null;
  enteredAt: string;
  state: string;
  keyword: string;
  wallAsks: number;
  recoveryStatus: string | null;
  recoveryArm: string | null;
  seenAt: string | null;
  suppressionReason: string | null;
}

export interface DropOffSummary {
  bucket: DropOffBucket;
  label: string;
  definition: string;
  total: number;
  byState: { expired: number; stillOpen: number };
  /**
   * Three-way on purpose. Folding noReadData into "unseen" would turn an
   * unknown into an accusation and point the fix at DM copy when the evidence
   * points at deliverability.
   */
  readEvidence: {
    confirmedSeen: number;
    trackedNeverConfirmed: number;
    noReadData: number;
    confirmedSeenOfTracked: GuardedRate;
  };
  recovery: {
    reminderSent: number;
    reminderSuppressed: number;
    inControlArm: number;
    noReminder: number;
  };
  rows: DropOffRow[];
}
