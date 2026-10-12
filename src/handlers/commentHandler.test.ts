import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const extractCandidates = vi.fn();
const scannableCommentMatchCandidates = vi.fn();
const findKeywordForComment = vi.fn();
const bindUpcomingAutomationFromComment = vi.fn();
const markGated = vi.fn();
const replyToComment = vi.fn();
const sendTrackedPrivateReply = vi.fn();
const logEvent = vi.fn();
const rememberUsername = vi.fn();
const getFollowState = vi.fn();
const enqueueGate = vi.fn();
const claimComment = vi.fn();
const openConversationIn = vi.fn();
const resolveJourneyIntent = vi.fn();
const recordJourneyPublicAcknowledgement = vi.fn();
const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const scheduleAcceptedGateRecovery = vi.fn();
const scheduleSettingsBlockedRecovery = vi.fn();
const scheduleTrackingUnavailableRecovery = vi.fn();
const resolveActiveSettingsBlockedVerification = vi.fn();
const gateOwner = vi.fn();
const recoveryFlags = { allTwoHour: false };
vi.mock("../services/flagService.js", () => ({ flags: { bool: () => recoveryFlags.allTwoHour } }));
const startCommentGuideRequest = vi.fn();
const recordGuideAccessMetric = vi.fn();
const authorizeNewGuideAction = vi.fn();
const linkReadiness = vi.fn();
const runCommentLinkGuide = vi.fn();

const RESOURCE_ID = "30000000-0000-4000-8000-000000000003";

const VERIFIED_SETTINGS_EVIDENCE = {
  verificationId: "10000000-0000-4000-8000-000000000017",
  verificationVersion: "settings-proof-2026-08-08-v1",
  graphCode: 10,
  graphSubcode: 12345,
  classifiedAt: new Date("2026-08-08T12:00:00Z"),
  verifiedAt: new Date("2026-08-08T10:00:00Z"),
  validUntil: new Date("2026-09-08T10:00:00Z"),
  evidenceReference: "meta-sandbox/settings-proof-2026-08-08-v1",
  evidenceSha256: "a".repeat(64),
};

// guideGateCard reaches lib/supabase for publicMediaUrl, and that module builds a client at
// import time — so without this the whole file fails to load rather than any test failing.
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
// The resolver is contract-tested against real Postgres; here the handler's own
// contract is what it does with each disposition.
vi.mock("../services/journeyIntentService.js", () => ({
  resolveJourneyIntent,
  recordJourneyPublicAcknowledgement,
}));
vi.mock("../meta/replyToComment.js", () => ({ replyToComment }));
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedPrivateReply }));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../services/igUserService.js", () => ({ rememberUsername, getFollowState }));
vi.mock("../services/gateQueueService.js", () => ({ enqueueGate }));
vi.mock("../services/commentClaimService.js", () => ({ claimComment }));
vi.mock("../lib/logger.js", () => ({
  logger: { child: () => childLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({
  env: {
    IG_USER_ID: "ig-account-owner",
    DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: "10:12345",
  },
}));
vi.mock("../services/dmRecoveryService.js", () => ({
  scheduleAcceptedGateRecovery,
  scheduleSettingsBlockedRecovery,
  scheduleTrackingUnavailableRecovery,
}));
vi.mock("../services/settingsBlockedVerificationService.js", () => ({
  resolveActiveSettingsBlockedVerification,
  settingsBlockedVerificationRejectionReason: (error: { reason?: string }) =>
    error?.reason ?? "verification_missing",
}));
vi.mock("../services/guideFollowGateV2Rollout.js", () => ({
  guideFollowGateV2Selector: { owner: gateOwner },
}));
vi.mock("../services/guideAccessActionService.js", () => ({ startCommentGuideRequest }));
vi.mock("../services/guideAccessMetrics.js", () => ({
  recordGuideAccessMetric,
}));
vi.mock("../services/guideAudienceAuthorization.js", () => ({
  guideAudienceAuthorization: { authorizeNewGuideAction },
}));
vi.mock("../services/linkGuideFlow.js", () => ({
  linkGuideFlow: { readiness: linkReadiness, runCommentLinkGuide, runDmLinkGuide: vi.fn() },
  linkGuideRepository: {},
}));

const { handleComment } = await import("./commentHandler.js");

const SENTINELS = [
  "PRIVATE-DM-SENTINEL",
  "ACCESS-TOKEN-SENTINEL",
  "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
  "PROVIDER-MESSAGE-SENTINEL",
  "REQUEST-BODY-SENTINEL",
  "ARBITRARY-AXIOS-CODE-SENTINEL",
];

function graphFailure(code = 100, subcode = 2534025): AxiosError {
  const error = new AxiosError(
    "PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
    "ARBITRARY-AXIOS-CODE-SENTINEL",
  );
  error.config = {
    headers: {} as never,
    url: SENTINELS[2],
    data: JSON.stringify({ text: "REQUEST-BODY-SENTINEL PRIVATE-DM-SENTINEL" }),
  };
  error.response = {
    status: 400,
    statusText: "Bad Request",
    headers: {},
    config: error.config,
    data: {
      error: {
        code,
        error_subcode: subcode,
        message: "PROVIDER-MESSAGE-SENTINEL",
        fbtrace_id: "trace_COMMENT-1",
      },
    },
  };
  return error;
}

beforeEach(() => {
  recoveryFlags.allTwoHour = false;
  for (const fn of [
    extractCandidates,
    scannableCommentMatchCandidates,
    findKeywordForComment,
    bindUpcomingAutomationFromComment,
    openConversationIn,
    resolveJourneyIntent,
    recordJourneyPublicAcknowledgement,
    markGated,
    replyToComment,
    sendTrackedPrivateReply,
    logEvent,
    rememberUsername,
    getFollowState,
    enqueueGate,
    scheduleAcceptedGateRecovery,
    scheduleSettingsBlockedRecovery,
    scheduleTrackingUnavailableRecovery,
    resolveActiveSettingsBlockedVerification,
    claimComment,
    gateOwner,
    startCommentGuideRequest,
    recordGuideAccessMetric,
    authorizeNewGuideAction,
    linkReadiness,
    runCommentLinkGuide,
    ...Object.values(childLogger),
  ]) {
    fn.mockReset();
  }
  linkReadiness.mockReturnValue("ready");
  runCommentLinkGuide.mockResolvedValue({
    outcome: "sent",
    sendId: "send-1",
    shape: "card",
    receipt: { instagramMessageId: "mid-1", dmMessageId: "dm-1", acceptedAt: new Date() },
  });

  // Default-off is the production default: every existing expectation below is
  // the V1 path, and only a test that opts in reaches V2.
  gateOwner.mockReturnValue("v1");
  startCommentGuideRequest.mockResolvedValue({ outcome: "guide_opening_sent" });
  recordGuideAccessMetric.mockResolvedValue("recorded");
  authorizeNewGuideAction.mockResolvedValue({ kind: "allow" });

  // The database enforces this in production; here a set stands in for it.
  const claimed = new Set<string>();
  claimComment.mockImplementation(async (commentId: string) =>
    claimed.has(commentId) ? false : (claimed.add(commentId), true),
  );
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
      gateMessage: "PRIVATE-DM-SENTINEL",
    },
  });
  bindUpcomingAutomationFromComment.mockResolvedValue({
    kind: "none",
    blockLegacyFallback: false,
  });
  openConversationIn.mockResolvedValue({ id: "conversation-1" });
  // Default: a first-time request, which is the only disposition that may send.
  resolveJourneyIntent.mockResolvedValue({
    disposition: "new_journey",
    intentId: "intent-1",
    conversationId: "conversation-1",
    maySendGate: true,
  });
  replyToComment.mockResolvedValue(undefined);
  recordJourneyPublicAcknowledgement.mockResolvedValue(undefined);
  logEvent.mockResolvedValue(undefined);
  rememberUsername.mockResolvedValue(undefined);
  getFollowState.mockResolvedValue({ isFollower: null, followerCount: null, isVerified: null });
  enqueueGate.mockResolvedValue(undefined);
  scheduleAcceptedGateRecovery.mockResolvedValue({ id: "rec-1", status: "waiting" });
  scheduleSettingsBlockedRecovery.mockResolvedValue({ id: "rec-2", status: "waiting" });
  scheduleTrackingUnavailableRecovery.mockResolvedValue({ id: "rec-3", status: "tracking_unavailable" });
  resolveActiveSettingsBlockedVerification.mockResolvedValue(VERIFIED_SETTINGS_EVIDENCE);
});

describe("upcoming automation webhook fast path", () => {
  const COMMENT = {
    id: "comment-upcoming-1",
    text: "HIGHCHAIR",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "scheduled-reel-1", media_product_type: "REELS" },
  };

  it("binds the first live comment before matching and completes the normal guide flow", async () => {
    extractCandidates.mockReturnValue(["HIGHCHAIR"]);
    scannableCommentMatchCandidates.mockReturnValue(["HIGHCHAIR"]);
    bindUpcomingAutomationFromComment.mockResolvedValue({
      kind: "bound",
      blockLegacyFallback: false,
    });
    findKeywordForComment.mockResolvedValue({
      mode: "post_strict",
      matchedToken: "HIGHCHAIR",
      keyword: {
        id: "bound-keyword",
        keyword: "HIGHCHAIR",
        mediaId: "scheduled-reel-1",
        publicReply: "Your high-chair guide is on its way.",
        gateMessage: "Follow and reply DONE for the high-chair guide.",
      },
    });
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date("2026-08-27T17:31:00.000Z"),
    });

    await handleComment(COMMENT);

    expect(bindUpcomingAutomationFromComment).toHaveBeenCalledWith({
      candidates: ["HIGHCHAIR"],
      mediaId: "scheduled-reel-1",
      commentId: "comment-upcoming-1",
    });
    expect(bindUpcomingAutomationFromComment.mock.invocationCallOrder[0]).toBeLessThan(
      findKeywordForComment.mock.invocationCallOrder[0]!,
    );
    expect(replyToComment).toHaveBeenCalledWith(
      "comment-upcoming-1",
      "Your high-chair guide is on its way.",
    );
    expect(sendTrackedPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: "comment-upcoming-1",
        text: "Follow and reply DONE for the high-chair guide.",
      }),
    );
  });

  it("never reaches a legacy global guide after an upcoming caption rejection", async () => {
    extractCandidates.mockReturnValue(["HIGHCHAIR"]);
    scannableCommentMatchCandidates.mockReturnValue(["HIGHCHAIR"]);
    bindUpcomingAutomationFromComment.mockResolvedValue({
      kind: "rejected",
      blockLegacyFallback: true,
    });
    // This is exactly the dangerous fallback: same word, historical guide.
    findKeywordForComment.mockResolvedValue({
      mode: "global_fallback",
      matchedToken: "HIGHCHAIR",
      keyword: {
        id: "legacy-keyword",
        keyword: "HIGHCHAIR",
        mediaId: null,
        publicReply: "Wrong public reply",
        gateMessage: "Wrong guide",
      },
    });

    await handleComment(COMMENT);

    expect(findKeywordForComment).not.toHaveBeenCalled();
    expect(claimComment).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("comment_ignored", {
      commentId: "comment-upcoming-1",
      candidate: "HIGHCHAIR",
      mediaId: "scheduled-reel-1",
      reason: "upcoming_automation_unresolved",
    });
  });
});

describe("handleComment Graph failure privacy", () => {
  it("logs, persists, and queues only the closed safe error descriptor", async () => {
    sendTrackedPrivateReply.mockRejectedValue(graphFailure());

    await handleComment({
      id: "comment-1",
      text: "sleep",
      from: { id: "ig-user-1", username: "parent" },
      media: { id: "media-1", media_product_type: "REELS" },
    });

    const safe = {
      category: "graph_response",
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 2534025,
      traceId: "trace_COMMENT-1",
      transportCode: null,
      // 100:2534025 is "comment invalid for a private reply" — permanent for
      // this comment, not a rate limit.
      classification: "permanent",
    };
    expect(logEvent).toHaveBeenCalledWith("dm_failed", {
      conversationId: "conversation-1",
      stage: "gate_private_reply",
      commentId: "comment-1",
      parentId: null,
      ...safe,
    });
    // 100:2534025 is permanent for this comment, so there is nothing to retry.
    expect(enqueueGate).not.toHaveBeenCalled();

    const captured = JSON.stringify({
      logs: childLogger.warn.mock.calls,
      events: logEvent.mock.calls.filter(([kind]) => kind === "dm_failed"),
    });
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });
});

describe("handleComment Recovery Scheduling (Task 6)", () => {
  it("schedules recovery from the exact accepted gate receipt", async () => {
    const acceptedAt = new Date("2026-08-06T08:00:00Z");
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt,
    });

    await handleComment({
      id: "comment-1",
      text: "sleep",
      from: { id: "ig-user-1", username: "parent" },
      media: { id: "media-1", media_product_type: "REELS" },
    });

    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      igUserId: "ig-user-1",
      keywordId: "keyword-1",
      keywordSnapshot: "SLEEP",
      commentId: "comment-1",
      mediaId: "media-1",
      instagramGateMessageId: "mid-1",
      gateDmMessageId: "dm-1",
      acceptedAt,
    });
    expect(markGated).toHaveBeenCalledWith("conversation-1");
  });

  it("does not enqueue a private-DM retry when recovery persistence fails after Meta success", async () => {
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date(),
    });
    scheduleAcceptedGateRecovery.mockRejectedValue(new Error("database unavailable"));

    await expect(
      handleComment({
        id: "comment-1",
        text: "sleep",
        from: { id: "ig-user-1", username: "parent" },
      }),
    ).resolves.toBeUndefined();

    expect(enqueueGate).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_schedule_failed",
      expect.objectContaining({ conversationId: "conversation-1", commentId: "comment-1" }),
    );
  });

  it("schedules settings blocked recovery immediately and does NOT enqueue gate retry", async () => {
    // subcode 12345 matches configured DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES="10:12345"
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(10, 12345));

    await handleComment({
      id: "comment-1",
      text: "sleep",
      from: { id: "ig-user-1", username: "parent" },
      media: { id: "media-1" },
    });

    expect(scheduleSettingsBlockedRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        igUserId: "ig-user-1",
        keywordId: "keyword-1",
        keywordSnapshot: "SLEEP",
        commentId: "comment-1",
        mediaId: "media-1",
        verification: VERIFIED_SETTINGS_EVIDENCE,
      }),
    );
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  it("fails closed when the allowlisted signature has no active verification", async () => {
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(10, 12345));
    resolveActiveSettingsBlockedVerification.mockRejectedValue(
      Object.assign(new Error("missing"), { reason: "verification_missing" }),
    );

    await handleComment({
      id: "comment-1",
      text: "sleep",
      from: { id: "ig-user-1", username: "parent" },
      media: { id: "media-1" },
    });

    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "dm_recovery_verification_rejected",
      expect.objectContaining({
        conversationId: "conversation-1",
        commentId: "comment-1",
        reason: "verification_missing",
      }),
    );
  });
});

// The plan's Task 6 acceptance list. Each of these guards a way the handler
// could either send a person a second DM or say the wrong thing to them.
describe("handleComment gate failure routing", () => {
  const COMMENT = {
    id: "comment-1",
    text: "sleep",
    from: { id: "ig-user-1", username: "parent" },
    media: { id: "media-1", media_product_type: "REELS" },
  };

  // A response-less failure may already have delivered the DM. It is parked for
  // review with an attention row, never silently retried.
  it("parks an ambiguous transport failure instead of queueing a retry", async () => {
    const timeout = new AxiosError("network", "ETIMEDOUT");
    sendTrackedPrivateReply.mockRejectedValue(timeout);

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({ initialErrorCategory: "transport_uncertain" }),
    );
    expect(scheduleTrackingUnavailableRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "comment-1", mediaId: "media-1" }),
    );
    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
  });

  // Settings-specific copy tells the person their own settings blocked the DM.
  // Saying that when it is not true is worse than saying nothing.
  it("never uses the settings path for a non-allowlisted error", async () => {
    // 10:99999 is not in the configured allowlist (10:12345).
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(10, 99999));

    await handleComment(COMMENT);

    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
    // An auth or permission failure cannot succeed on a retry either; queueing
    // it only spends an attempt and delays the owner noticing.
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  it("still queues a genuinely retryable failure", async () => {
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(4, 0));

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({ initialErrorCategory: "rate_limited" }),
    );
  });

  it("still sends the gate and schedules recovery when the public reply fails", async () => {
    replyToComment.mockRejectedValue(new Error("public reply rejected"));
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date("2026-08-06T08:00:00Z"),
    });

    await handleComment(COMMENT);

    expect(sendTrackedPrivateReply).toHaveBeenCalledOnce();
    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "comment-1", instagramGateMessageId: "mid-1" }),
    );
  });

  // Our own public replies come back through the webhook like anyone else's.
  // Acting on them is a self-reply loop.
  it("creates nothing for a comment authored by the business account", async () => {
    await handleComment({ ...COMMENT, from: { id: "ig-account-owner", username: "tinysoho" } });

    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(scheduleAcceptedGateRecovery).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});

// Meta delivers webhooks at least once. Without an idempotency key the handler
// runs end to end again: measured before this guard existed, one duplicate
// produced two public replies, two gate DMs, and two conversations.
describe("duplicate comment webhook delivery", () => {
  const COMMENT = {
    id: "comment_sarah_001",
    text: "sleep",
    from: { id: "ig_sarah", username: "sarah" },
    media: { id: "reel_42", media_product_type: "REELS" },
  };

  it("does exactly one of everything when the gate DM succeeds", async () => {
    sendTrackedPrivateReply.mockResolvedValue({ messageId: "mid-1" });

    await handleComment(COMMENT);
    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(1);
    expect(resolveJourneyIntent).toHaveBeenCalledTimes(1);
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  it("does exactly one of everything when the gate DM fails and is queued", async () => {
    sendTrackedPrivateReply.mockRejectedValue(new Error("rate limited"));

    await handleComment(COMMENT);
    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(resolveJourneyIntent).toHaveBeenCalledTimes(1);
    expect(enqueueGate).toHaveBeenCalledTimes(1);
  });

  // The guard is an insert whose uniqueness the database enforces, so two
  // deliveries interleaving cannot both pass a check-then-act window.
  it("claims the comment before anything reaches Instagram", async () => {
    sendTrackedPrivateReply.mockResolvedValue({ messageId: "mid-1" });

    await handleComment(COMMENT);

    expect(claimComment).toHaveBeenCalledWith("comment_sarah_001", "ig_sarah");
    const claimOrder = claimComment.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(replyToComment.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(sendTrackedPrivateReply.mock.invocationCallOrder[0]!);
    expect(claimOrder).toBeLessThan(resolveJourneyIntent.mock.invocationCallOrder[0]!);
  });

  it("ignores a comment that matches no keyword without consuming a claim", async () => {
    findKeywordForComment.mockResolvedValue(null);

    await handleComment(COMMENT);

    expect(claimComment).not.toHaveBeenCalled();
  });
});

// The behaviour Feature 3 exists for. Two comments for the same guide are two
// different Meta comment ids, so the comment claim cannot merge them — it only
// stops the SAME comment being delivered twice. Before this, asking twice meant
// two journeys and two gate DMs; that happened 342 times in production.
describe("duplicate journey suppression", () => {
  const COMMENT = {
    id: "comment-second-ask",
    text: "sleep",
    from: { id: "ig-user-1", username: "parent" },
    media: { id: "media-1", media_product_type: "REELS" },
  };

  function reusedJourney() {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });
  }

  it("sends the warm gate and records its variant for a cached follower", async () => {
    getFollowState.mockResolvedValue({ isFollower: true, followerCount: null, isVerified: null });
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date("2026-08-20T16:54:00.000Z"),
    });

    await handleComment(COMMENT);

    expect(sendTrackedPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.",
      }),
    );
    expect(logEvent).toHaveBeenCalledWith("dm_sent", {
      conversationId: "conversation-1",
      kind: "gate",
      gateVariant: "known_follower",
    });
  });

  it("uses the default gate and a safe diagnostic when cached follow state cannot be read", async () => {
    getFollowState.mockRejectedValue(new Error("FOLLOW-CACHE-ERROR-SENTINEL"));
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date("2026-08-20T16:54:00.000Z"),
    });

    await handleComment(COMMENT);

    expect(getFollowState).toHaveBeenCalledWith("ig-user-1");
    expect(sendTrackedPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "PRIVATE-DM-SENTINEL" }),
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      { igUserId: "ig-user-1", followerState: "unavailable" },
      "Cached follower state unavailable; using default gate",
    );
    const capturedLogs = JSON.stringify(childLogger.warn.mock.calls);
    expect(capturedLogs).not.toContain("FOLLOW-CACHE-ERROR-SENTINEL");
  });

  it("queues the selected warm gate text after a failed send", async () => {
    getFollowState.mockResolvedValue({ isFollower: true, followerCount: null, isVerified: null });
    sendTrackedPrivateReply.mockRejectedValue(new Error("rate limited"));

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({
        gateMessage: "So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.",
      }),
    );
  });

  it("sends no second gate DM when the journey is reused", async () => {
    reusedJourney();

    await handleComment(COMMENT);

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(scheduleAcceptedGateRecovery).not.toHaveBeenCalled();
    expect(getFollowState).not.toHaveBeenCalled();
  });

  // The public reply is per-COMMENT, not per-journey: a comment left visibly
  // unanswered reads as being ignored, even when the DM already went out.
  it("still answers the comment publicly", async () => {
    reusedJourney();
    replyToComment.mockResolvedValue({ replyId: "public-reply-1" });

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(recordJourneyPublicAcknowledgement).toHaveBeenCalledWith({
      commentId: COMMENT.id,
      keywordId: "keyword-1",
      state: "confirmed",
      replyId: "public-reply-1",
      errorCategory: null,
    });
  });

  it("records a safe failed acknowledgement without losing the journey association", async () => {
    reusedJourney();
    replyToComment.mockRejectedValue(graphFailure(100, 2534025));

    await handleComment(COMMENT);

    expect(recordJourneyPublicAcknowledgement).toHaveBeenCalledWith({
      commentId: COMMENT.id,
      keywordId: "keyword-1",
      state: "failed",
      replyId: null,
      errorCategory: "graph_response",
    });
  });

  it("records why the gate was withheld", async () => {
    reusedJourney();

    await handleComment(COMMENT);

    const kinds = logEvent.mock.calls.map(([kind]) => kind);
    expect(kinds).toContain("gate_withheld_duplicate_journey");
  });

  it("withholds for a request completed inside the window", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "already_completed_recently",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });

    await handleComment(COMMENT);

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
  });

  // A redelivered webhook reaching the resolver must also stay silent. The comment
  // claim normally catches this first; this is the second line of defence.
  it("withholds for a replayed comment", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "replayed_comment",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });

    await handleComment(COMMENT);

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
  });

  it("names the journey it joined on keyword_matched", async () => {
    reusedJourney();

    await handleComment(COMMENT);

    const matched = logEvent.mock.calls.find(([kind]) => kind === "keyword_matched");
    expect(matched?.[1]).toMatchObject({ journeyDisposition: "reused_active" });
  });
});

describe("guide audience policy — comment path", () => {
  const COMMENT = {
    id: "comment-audience-1",
    text: "sleep",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-1", media_product_type: "REELS" },
  };

  it("sends nothing when a matched comment is blocked", async () => {
    authorizeNewGuideAction.mockResolvedValue({ kind: "block", auditId: "audit-1" });

    await handleComment(COMMENT);

    expect(authorizeNewGuideAction).toHaveBeenCalledWith({
      igUserId: "ig-parent",
      source: "comment",
      commentId: COMMENT.id,
      resourceId: RESOURCE_ID,
    });
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(replyToComment).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(startCommentGuideRequest).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  // Fail open. A gate that cannot reach a verdict silenced 46 of 60 people
  // during the NVIDIA incident, 21 of them confirmed US audience.
  it("still replies when the audience gate throws", async () => {
    authorizeNewGuideAction.mockRejectedValue(new Error("boom"));
    // The send now runs to completion, so the gate DM has to return a receipt.
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date("2026-09-27T12:00:00.000Z"),
    });

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(1);
  });
});

// Task 7: the strict gate replaces cached-follow-state authorization on the
// comment path. V1 must survive untouched while the switch is off, and no
// webhook may ever execute both paths.
describe("strict follower gate v2 — comment path", () => {
  const COMMENT = {
    id: "comment-v2-1",
    text: "sleep",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-1", media_product_type: "REELS" },
  };

  it("keeps the entire V1 gate path when the switch is off", async () => {
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-v1",
      recipientIgUserId: "ig-parent",
      status: "sent",
    });

    await handleComment(COMMENT);

    expect(getFollowState).toHaveBeenCalledWith("ig-parent");
    expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(1);
    // A delivered gate needs no retry row; enqueueGate is the failure path only.
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(markGated).toHaveBeenCalledWith("conversation-1");
    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledTimes(1);
    expect(startCommentGuideRequest).not.toHaveBeenCalled();
    expect(recordGuideAccessMetric).not.toHaveBeenCalled();
  });

  it("routes an allowlisted journey to the strict opening and runs no V1 gate", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    expect(startCommentGuideRequest).toHaveBeenCalledTimes(1);
    expect(startCommentGuideRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        igUserId: "ig-parent",
        resourceId: RESOURCE_ID,
        commentId: COMMENT.id,
      }),
    );
    // Mutual exclusivity: not one V1 gate side effect may run.
    expect(getFollowState).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(markGated).not.toHaveBeenCalled();
    expect(scheduleAcceptedGateRecovery).not.toHaveBeenCalled();
  });

  it("schedules a strict opening from its confirmed receipt when two-hour rollout is active", async () => {
    recoveryFlags.allTwoHour = true;
    gateOwner.mockReturnValue("v2");
    const receipt = {instagramMessageId: "strict-mid", dmMessageId: "strict-dm", acceptedAt: new Date("2026-10-05T08:00:00Z")};
    startCommentGuideRequest.mockResolvedValue({outcome: "guide_opening_sent", openingReceipt: receipt});
    await handleComment(COMMENT);
    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      commentId: COMMENT.id, instagramGateMessageId: receipt.instagramMessageId,
      gateDmMessageId: receipt.dmMessageId, acceptedAt: receipt.acceptedAt,
    }));
  });

  it("does not retry a delivered strict opening when reminder persistence fails", async () => {
    recoveryFlags.allTwoHour = true;
    gateOwner.mockReturnValue("v2");
    startCommentGuideRequest.mockResolvedValue({outcome: "guide_opening_sent", openingReceipt: {instagramMessageId: "strict-mid", dmMessageId: null, acceptedAt: new Date()}});
    scheduleAcceptedGateRecovery.mockRejectedValue(new Error("database unavailable"));
    await handleComment(COMMENT);
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("dm_recovery_schedule_failed", expect.anything());
  });

  it("decides ownership once, from the sender and the guide only", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    expect(gateOwner).toHaveBeenCalledTimes(1);
    expect(gateOwner).toHaveBeenCalledWith({
      igUserId: "ig-parent",
      resourceId: RESOURCE_ID,
    });
  });

  it("still answers the comment publicly on the strict path", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    // The public acknowledgement is per-comment in both paths; a visibly
    // unanswered comment reads as being ignored.
    expect(replyToComment).toHaveBeenCalledWith(COMMENT.id, "Check your DMs");
  });

  it("sends no strict opening for a journey that already has one", async () => {
    gateOwner.mockReturnValue("v2");
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });

    await handleComment(COMMENT);

    expect(startCommentGuideRequest).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "guide_opening_sent", want: "accepted" },
    { outcome: "guide_opening_failed", want: "failed" },
    { outcome: "access_attempt_needs_review", want: "uncertain" },
  ])("records the $want opening outcome as an aggregate", async ({ outcome, want }) => {
    gateOwner.mockReturnValue("v2");
    startCommentGuideRequest.mockResolvedValue({ outcome });

    await handleComment(COMMENT);

    expect(recordGuideAccessMetric).toHaveBeenCalledWith("opening", want);
  });

  it("records no opening metric when no opening was sent", async () => {
    gateOwner.mockReturnValue("v2");
    startCommentGuideRequest.mockResolvedValue({ outcome: "guide_opening_already_sent" });

    await handleComment(COMMENT);

    expect(recordGuideAccessMetric).not.toHaveBeenCalled();
  });

  it("keeps a strict-path failure non-fatal for the webhook", async () => {
    gateOwner.mockReturnValue("v2");
    startCommentGuideRequest.mockRejectedValue(new Error("strict path exploded"));

    await expect(handleComment(COMMENT)).resolves.toBeUndefined();

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
  });

  it("falls back to V1 when ownership cannot be decided", async () => {
    gateOwner.mockImplementation(() => {
      throw new Error("flag read failed");
    });
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-v1",
      recipientIgUserId: "ig-parent",
      status: "sent",
    });

    await handleComment(COMMENT);

    expect(startCommentGuideRequest).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(1);
  });
});

// Task 9. A failed strict opening used to be a permanent silent drop. V1 answers the
// same failure with a five-branch ladder; V2 now runs the identical ladder, with the
// only difference being the copy a queued retry re-sends.
describe("strict opening failure recovery", () => {
  const COMMENT = {
    id: "comment-recovery-1",
    text: "sleep",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-1", media_product_type: "REELS" },
  };
  const RETRY_TEXT =
    "Got it 💛 I've got it ready for you. Want me to send it here? Reply YES and I'll send it over.";

  // HTTP 503: Meta answered and did not accept the send, so it is provably
  // retryable ("retryable_transport"). A 400 would classify as "permanent" and
  // correctly queue nothing.
  function gatewayFailure(): AxiosError {
    const error = new AxiosError("gateway", "ERR_BAD_RESPONSE");
    error.config = { headers: {} as never };
    error.response = {
      status: 503,
      statusText: "Service Unavailable",
      headers: {},
      config: error.config,
      data: {},
    };
    return error;
  }

  function failing(outcome: string, error: unknown) {
    gateOwner.mockReturnValue("v2");
    startCommentGuideRequest.mockResolvedValue({
      outcome,
      openingSendFailure: { error, retryText: RETRY_TEXT },
    });
  }

  it("queues the STRICT opening copy, never the V1 gate message", async () => {
    failing("guide_opening_failed", gatewayFailure());

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledTimes(1);
    const queued = enqueueGate.mock.calls[0]![0];
    expect(queued).toMatchObject({
      conversationId: "conversation-1",
      igUserId: "ig-parent",
      commentId: COMMENT.id,
      gateMessage: RETRY_TEXT,
    });
    // Deliberately no `not.toBe(V1 copy)` assertion here: RETRY_TEXT is a literal
    // this test feeds through the mock, so such a check could never fail. The real
    // provenance — that the retry copy IS `guideAccessOpeningText` — is proven at the
    // service boundary in guideAccessActionService.test.ts.
  });

  it("routes a settings-blocked failure to the settings recovery and queues nothing", async () => {
    failing("guide_opening_failed", graphFailure(10, 12345));

    await handleComment(COMMENT);

    expect(scheduleSettingsBlockedRecovery).toHaveBeenCalledTimes(1);
    expect(scheduleSettingsBlockedRecovery.mock.calls[0]![0]).toMatchObject({
      conversationId: "conversation-1",
      igUserId: "ig-parent",
      keywordId: "keyword-1",
      commentId: COMMENT.id,
    });
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  it("queues nothing for a permanent rejection that cannot succeed on a retry", async () => {
    failing("guide_opening_failed", graphFailure(100, 2534025));

    await handleComment(COMMENT);

    expect(enqueueGate).not.toHaveBeenCalled();
    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
    expect(scheduleTrackingUnavailableRecovery).not.toHaveBeenCalled();
  });

  it("parks an uncertain opening for the owner and also records a recovery row", async () => {
    failing("access_attempt_needs_review", new AxiosError("timed out", "ETIMEDOUT"));

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledTimes(1);
    expect(enqueueGate.mock.calls[0]![0]).toMatchObject({
      gateMessage: RETRY_TEXT,
      initialErrorCategory: expect.stringMatching(/uncertain/),
    });
    expect(scheduleTrackingUnavailableRecovery).toHaveBeenCalledTimes(1);
  });

  it("records the failure under the same event stage as V1 so the baseline stays comparable", async () => {
    failing("guide_opening_failed", gatewayFailure());

    await handleComment(COMMENT);

    expect(logEvent).toHaveBeenCalledWith(
      "dm_failed",
      expect.objectContaining({
        conversationId: "conversation-1",
        stage: "gate_private_reply",
        commentId: COMMENT.id,
      }),
    );
  });

  it("does nothing extra when the opening succeeded", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    expect(enqueueGate).not.toHaveBeenCalled();
    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
    expect(scheduleTrackingUnavailableRecovery).not.toHaveBeenCalled();
  });
});

describe("link guides — comment path", () => {
  const LINK_RESOURCE = {
    id: RESOURCE_ID,
    name: "Halloween collection",
    description: null,
    deliveryMode: "link",
    linkUrl: "https://mycuratedhaven.com/halloween",
    linkButtonLabel: "Open the recipes",
    linkCardTitle: "Your Halloween recipes 👻",
    linkCardSubtitle: null,
  };
  const COMMENT = {
    id: "comment-link-1",
    text: "GHOST",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-9", media_product_type: "REELS" },
  };

  beforeEach(() => {
    extractCandidates.mockReturnValue(["GHOST"]);
    scannableCommentMatchCandidates.mockReturnValue(["GHOST"]);
    findKeywordForComment.mockResolvedValue({
      mode: "post_strict",
      matchedToken: "GHOST",
      keyword: {
        id: "keyword-ghost",
        keyword: "GHOST",
        mediaId: "reel-9",
        resourceId: RESOURCE_ID,
        publicReply: "Sent you the recipes",
        gateMessage: "unused",
        resource: LINK_RESOURCE,
      },
    });
  });

  it("replies publicly, sends the link, and never starts the follow gate", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledWith("comment-link-1", "Sent you the recipes");
    expect(runCommentLinkGuide).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      keywordId: "keyword-ghost",
      keywordSnapshot: "GHOST",
      commentId: "comment-link-1",
      mediaId: "reel-9",
      igUserId: "ig-parent",
      resource: LINK_RESOURCE,
    });
    expect(gateOwner).not.toHaveBeenCalled();
    expect(startCommentGuideRequest).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "keyword_matched",
      expect.objectContaining({ deliveryMode: "link" }),
    );
  });

  it("stays silent before the public reply when link guides are switched off", async () => {
    linkReadiness.mockReturnValue("disabled");

    await handleComment(COMMENT);

    expect(replyToComment).not.toHaveBeenCalled();
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(runCommentLinkGuide).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("link_guide_disabled", {
      commentId: "comment-link-1",
      keywordId: "keyword-ghost",
      resourceId: RESOURCE_ID,
    });
  });

  it("queues the text-with-link retry when the link DM fails", async () => {
    runCommentLinkGuide.mockResolvedValue({
      outcome: "failed",
      sendId: "send-1",
      shape: "card",
      error: new Error("socket hang up"),
      retryText: "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG",
    });

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        commentId: "comment-link-1",
        gateMessage: "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG",
      }),
    );
  });

  it("sends nothing more for a repeat comment inside the same journey", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(runCommentLinkGuide).not.toHaveBeenCalled();
  });
});
