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
const claimComment = vi.fn();
const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
vi.mock("../services/commentClaimService.js", () => ({ claimComment }));
vi.mock("../lib/logger.js", () => ({ logger: { child: () => childLogger } }));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "ig-account-owner" } }));

const { handleComment } = await import("./commentHandler.js");

const SENTINELS = [
  "PRIVATE-DM-SENTINEL",
  "ACCESS-TOKEN-SENTINEL",
  "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
  "PROVIDER-MESSAGE-SENTINEL",
  "REQUEST-BODY-SENTINEL",
  "ARBITRARY-AXIOS-CODE-SENTINEL",
];

function graphFailure(): AxiosError {
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
        code: 100,
        error_subcode: 2534025,
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
    claimComment,
    ...Object.values(childLogger),
  ]) {
    fn.mockReset();
  }

  // The database enforces this in production; here a set stands in for it.
  const claimed = new Set<string>();
  claimComment.mockImplementation(async (commentId: string) =>
    claimed.has(commentId) ? false : (claimed.add(commentId), true),
  );
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
    };
    expect(childLogger.warn).toHaveBeenCalledWith(safe, "Gate private reply failed");
    expect(logEvent).toHaveBeenCalledWith("dm_failed", {
      conversationId: "conversation-1",
      stage: "gate_private_reply",
      commentId: "comment-1",
      parentId: null,
      ...safe,
    });
    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: "graph_response" }),
    );

    const captured = JSON.stringify({
      logs: childLogger.warn.mock.calls,
      events: logEvent.mock.calls.filter(([kind]) => kind === "dm_failed"),
      lastError: enqueueGate.mock.calls[0]?.[0]?.lastError,
    });
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
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
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(enqueueGate).not.toHaveBeenCalled();
  });

  it("does exactly one of everything when the gate DM fails and is queued", async () => {
    sendTrackedPrivateReply.mockRejectedValue(new Error("rate limited"));

    await handleComment(COMMENT);
    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(openConversation).toHaveBeenCalledTimes(1);
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
    expect(claimOrder).toBeLessThan(openConversation.mock.invocationCallOrder[0]!);
  });

  it("ignores a comment that matches no keyword without consuming a claim", async () => {
    findKeywordForComment.mockResolvedValue(null);

    await handleComment(COMMENT);

    expect(claimComment).not.toHaveBeenCalled();
  });
});
