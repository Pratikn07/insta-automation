import { beforeEach, describe, expect, it, vi } from "vitest";

// Every other test of this gate asserts against a mock of the gate, of
// `replyToComment`, or of `dmDeliveryService` — so all of them would still pass
// if the handler called the real gate and then sent anyway. This file removes
// those three mocks and asserts the only thing the person on the other end
// actually experiences: whether an HTTP request leaves for Meta.
//
// `graph.post` is the single chokepoint. `replyToComment` is a one-line wrapper
// over it, and every DM send in dmDeliveryService reaches it through
// meta/sendMessage.js. Mocking it here therefore catches a public reply and a
// DM equally, from the real handler through the real gate.

const extractCandidates = vi.fn();
const scannableCommentMatchCandidates = vi.fn();
const findKeywordForComment = vi.fn();
const bindUpcomingAutomationFromComment = vi.fn();
const openConversationIn = vi.fn();
const markGated = vi.fn();
const resolveJourneyIntent = vi.fn();
const recordJourneyPublicAcknowledgement = vi.fn();
const logEvent = vi.fn();
const rememberUsername = vi.fn();
const getFollowState = vi.fn();
const enqueueGate = vi.fn();
const claimComment = vi.fn();
const gateOwner = vi.fn();
const startCommentGuideRequest = vi.fn();
const recordGuideAccessMetric = vi.fn();
const recordOutboundMessage = vi.fn();

const graphPost = vi.fn();
const graphGet = vi.fn();
const geminiPost = vi.fn();

const igUserFindUnique = vi.fn();
const guideAudienceDecisionCreate = vi.fn();
const igUserUpdateMany = vi.fn();

const RESOURCE_ID = "30000000-0000-4000-8000-000000000003";
const SOUTH_ASIAN_COMMENTER = "ig-priya";

// guideGateCard reaches lib/supabase for publicMediaUrl, and that module builds a
// client at import time.
vi.mock("../lib/supabase.js", () => ({
  publicMediaUrl: (path: string) => `https://cdn.example.test/${path}`,
  serverMediaBucket: () => ({}),
  supabase: {},
}));
vi.mock("../services/keywordService.js", () => ({
  extractCandidates,
  scannableCommentMatchCandidates,
  findKeywordForComment,
}));
vi.mock("../services/upcomingAutomationCommentBinding.js", () => ({
  bindUpcomingAutomationFromComment,
}));
vi.mock("../services/conversationService.js", () => ({ openConversationIn, markGated }));
vi.mock("../services/journeyIntentService.js", () => ({
  resolveJourneyIntent,
  recordJourneyPublicAcknowledgement,
}));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../services/igUserService.js", () => ({ rememberUsername, getFollowState }));
vi.mock("../services/gateQueueService.js", () => ({ enqueueGate }));
vi.mock("../services/commentClaimService.js", () => ({ claimComment }));
vi.mock("../services/dmRecoveryService.js", () => ({
  scheduleAcceptedGateRecovery: vi.fn(),
  scheduleSettingsBlockedRecovery: vi.fn(),
  scheduleTrackingUnavailableRecovery: vi.fn(),
}));
vi.mock("../services/settingsBlockedVerificationService.js", () => ({
  resolveActiveSettingsBlockedVerification: vi.fn().mockResolvedValue(null),
  settingsBlockedVerificationRejectionReason: () => "verification_missing",
}));
vi.mock("../services/guideFollowGateV2Rollout.js", () => ({
  guideFollowGateV2Selector: { owner: gateOwner },
}));
vi.mock("../services/guideAccessActionService.js", () => ({ startCommentGuideRequest }));
vi.mock("../services/guideAccessMetrics.js", () => ({ recordGuideAccessMetric }));
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The real flag service reads this record when its override cache is cold, which
// is the same path production takes between refreshes. So the gate below is
// switched on exactly the way an operator switches it on.
vi.mock("../config/env.js", () => ({
  env: {
    IG_USER_ID: "ig-account-owner",
    IG_ACCESS_TOKEN: "ACCESS-TOKEN-SENTINEL",
    DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: "10:12345",
    GUIDE_AUDIENCE_BLOCK_ENABLED: true,
    GUIDE_AUDIENCE_TIMEOUT_MS: 3_000,
  },
}));
vi.mock("../meta/graphClient.js", () => ({
  GRAPH_VERSION: "v21.0",
  graph: { post: graphPost, get: graphGet },
}));
vi.mock("../meta/geminiClient.js", () => ({
  gemini: { post: geminiPost },
  geminiEnabled: true,
  GeminiDisabledError: class GeminiDisabledError extends Error {},
}));
vi.mock("../services/dmThreadService.js", () => ({ recordOutboundMessage }));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    igUser: { findUnique: igUserFindUnique, updateMany: igUserUpdateMany },
    guideAudienceDecision: { create: guideAudienceDecisionCreate },
    flagOverride: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../services/linkGuideFlow.js", () => ({
  linkGuideFlow: { readiness: vi.fn(() => "ready"), runCommentLinkGuide: vi.fn(), runDmLinkGuide: vi.fn() },
  linkGuideRepository: {},
}));

const { handleComment } = await import("./commentHandler.js");
const { guideAudienceAuthorization } = await import(
  "../services/guideAudienceAuthorization.js"
);

const COMMENT = {
  id: "comment-priya-1",
  text: "SLEEP",
  from: { id: SOUTH_ASIAN_COMMENTER, username: "priya_mommy" },
  media: { id: "reel-1", media_product_type: "REELS" },
};

beforeEach(() => {
  vi.clearAllMocks();

  igUserFindUnique.mockResolvedValue({
    id: SOUTH_ASIAN_COMMENTER,
    username: "priya_mommy",
    name: "Priya Sharma",
    inferredOrigin: "south_asian",
    originConfidence: "high",
    originMethod: "llm_v3",
  });
  guideAudienceDecisionCreate.mockResolvedValue({
    id: "20000000-0000-4000-8000-000000000001",
  });

  graphPost.mockResolvedValue({ data: { id: "reply-1", message_id: "mid-1" } });
  recordOutboundMessage.mockResolvedValue({
    dmMessageId: "dm-1",
    acceptedAt: new Date("2026-09-27T12:00:00.000Z"),
  });

  gateOwner.mockReturnValue("v1");
  startCommentGuideRequest.mockResolvedValue({ outcome: "guide_opening_sent" });
  recordGuideAccessMetric.mockResolvedValue("recorded");
  claimComment.mockResolvedValue(true);
  extractCandidates.mockReturnValue(["sleep"]);
  scannableCommentMatchCandidates.mockReturnValue(["SLEEP"]);
  findKeywordForComment.mockResolvedValue({
    mode: "global_fallback",
    matchedToken: "sleep",
    keyword: {
      id: "keyword-1",
      keyword: "SLEEP",
      mediaId: null,
      resourceId: RESOURCE_ID,
      publicReply: "Check your DMs",
      gateMessage: "Follow and reply DONE for the sleep guide.",
    },
  });
  bindUpcomingAutomationFromComment.mockResolvedValue({
    kind: "none",
    blockLegacyFallback: false,
  });
  openConversationIn.mockResolvedValue({ id: "conversation-1" });
  resolveJourneyIntent.mockResolvedValue({
    disposition: "new_journey",
    intentId: "intent-1",
    conversationId: "conversation-1",
    maySendGate: true,
  });
  logEvent.mockResolvedValue(undefined);
  rememberUsername.mockResolvedValue(undefined);
  getFollowState.mockResolvedValue({ isFollower: null, followerCount: null, isVerified: null });
  enqueueGate.mockResolvedValue(undefined);
});

describe("guide audience gate, end to end at the network boundary", () => {
  it("sends no public reply and no DM for a south_asian commenter", async () => {
    await handleComment(COMMENT);

    // The whole feature, in one assertion: nothing left for Meta.
    expect(graphPost).not.toHaveBeenCalled();
    // And nothing was billed, because the stored verdict already answered.
    expect(geminiPost).not.toHaveBeenCalled();
  });

  it("stops before the journey is ever resolved", async () => {
    await handleComment(COMMENT);

    // Cheaper to debug than a missing HTTP call: the gate returns above this.
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(openConversationIn).not.toHaveBeenCalled();
  });

  it("audits the block through the real repository", async () => {
    await handleComment(COMMENT);

    expect(guideAudienceDecisionCreate).toHaveBeenCalledTimes(1);
    const data = guideAudienceDecisionCreate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      igUserId: SOUTH_ASIAN_COMMENTER,
      kind: "block",
      source: "comment",
      origin: "south_asian",
      confidence: "high",
      provider: "gemini",
      method: "llm_v3",
      commentId: COMMENT.id,
      resourceId: RESOURCE_ID,
    });
    // The audit row carries a hash, never the profile it was computed from.
    expect(JSON.stringify(data)).not.toContain("priya_mommy");
    expect(JSON.stringify(data)).not.toContain("Priya Sharma");
  });

  // Same person, same stored verdict, the other inbound surface. The DM
  // handler's own wiring is covered in messageHandler.test.ts; what this proves
  // is that the live singleton — real flag read, real repository, real store —
  // withholds a DM-sourced action too.
  it("blocks a dm-sourced action from the same stored verdict", async () => {
    await expect(
      guideAudienceAuthorization.authorizeNewGuideAction({
        igUserId: SOUTH_ASIAN_COMMENTER,
        source: "dm",
        inboundMessageId: "mid-1",
        resourceId: RESOURCE_ID,
      }),
    ).resolves.toMatchObject({ kind: "block" });
    expect(graphPost).not.toHaveBeenCalled();
    expect(geminiPost).not.toHaveBeenCalled();
  });

  // The counterpart: the same real wiring must NOT withhold from a western
  // reader, or this feature is an outage rather than a filter.
  it("lets a us_western commenter through to Meta", async () => {
    igUserFindUnique.mockResolvedValue({
      id: "ig-sarah",
      username: "sarah_mom",
      name: "Sarah Miller",
      inferredOrigin: "us_western",
      originConfidence: "high",
      originMethod: "llm_v3",
    });

    await handleComment({ ...COMMENT, from: { id: "ig-sarah", username: "sarah_mom" } });

    // The public reply is the first thing the handler sends, and it goes out
    // through the same `graph.post` the block case proves silent.
    expect(graphPost).toHaveBeenCalledWith(
      `/${COMMENT.id}/replies`,
      expect.objectContaining({ message: "Check your DMs" }),
    );
    expect(guideAudienceDecisionCreate).not.toHaveBeenCalled();
  });
});
