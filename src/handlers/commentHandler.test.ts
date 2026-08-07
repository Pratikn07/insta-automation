import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const extractCandidates = vi.fn();
const findKeywordForComment = vi.fn();
const openConversation = vi.fn();
const markGated = vi.fn();
const replyToComment = vi.fn();
const sendTrackedPrivateReply = vi.fn();
const logEvent = vi.fn();
const rememberUsername = vi.fn();
const enqueueGate = vi.fn();
const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const scheduleAcceptedGateRecovery = vi.fn();
const scheduleSettingsBlockedRecovery = vi.fn();
const scheduleTrackingUnavailableRecovery = vi.fn();

vi.mock("../services/keywordService.js", () => ({
  extractCandidates,
  findKeywordForComment,
}));
vi.mock("../services/conversationService.js", () => ({ openConversation, markGated }));
vi.mock("../meta/replyToComment.js", () => ({ replyToComment }));
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedPrivateReply }));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../services/igUserService.js", () => ({ rememberUsername }));
vi.mock("../services/gateQueueService.js", () => ({ enqueueGate }));
vi.mock("../lib/logger.js", () => ({ logger: { child: () => childLogger } }));
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
  for (const fn of [
    extractCandidates,
    findKeywordForComment,
    openConversation,
    markGated,
    replyToComment,
    sendTrackedPrivateReply,
    logEvent,
    rememberUsername,
    enqueueGate,
    scheduleAcceptedGateRecovery,
    scheduleSettingsBlockedRecovery,
    scheduleTrackingUnavailableRecovery,
    ...Object.values(childLogger),
  ]) {
    fn.mockReset();
  }
  extractCandidates.mockReturnValue(["sleep"]);
  findKeywordForComment.mockResolvedValue({
    mode: "global_fallback",
    matchedToken: "sleep",
    keyword: {
      id: "keyword-1",
      keyword: "SLEEP",
      mediaId: null,
      publicReply: "Check your DMs",
      gateMessage: "PRIVATE-DM-SENTINEL",
    },
  });
  openConversation.mockResolvedValue({ id: "conversation-1" });
  replyToComment.mockResolvedValue(undefined);
  logEvent.mockResolvedValue(undefined);
  rememberUsername.mockResolvedValue(undefined);
  enqueueGate.mockResolvedValue(undefined);
  scheduleAcceptedGateRecovery.mockResolvedValue({ id: "rec-1", status: "waiting" });
  scheduleSettingsBlockedRecovery.mockResolvedValue({ id: "rec-2", status: "waiting" });
  scheduleTrackingUnavailableRecovery.mockResolvedValue({ id: "rec-3", status: "tracking_unavailable" });
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
    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: "graph_response",
        mediaId: "media-1",
        initialErrorCategory: "permanent",
      }),
    );

    const captured = JSON.stringify({
      logs: childLogger.warn.mock.calls,
      events: logEvent.mock.calls.filter(([kind]) => kind === "dm_failed"),
      lastError: enqueueGate.mock.calls[0]?.[0]?.lastError,
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
      }),
    );
    expect(enqueueGate).not.toHaveBeenCalled();
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
    expect(enqueueGate).toHaveBeenCalledOnce();
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

    expect(openConversation).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(enqueueGate).not.toHaveBeenCalled();
    expect(scheduleAcceptedGateRecovery).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
