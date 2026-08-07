import { describe, it, expect, vi, beforeEach } from "vitest";

const keywordFindUnique = vi.fn();
const eventLogFindMany = vi.fn();
const conversationFindMany = vi.fn();
const openConversation = vi.fn();
const enqueueGate = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    keyword: { findUnique: keywordFindUnique },
    eventLog: { findMany: eventLogFindMany },
    conversation: { findMany: conversationFindMany },
  },
}));
vi.mock("./conversationService.js", () => ({ openConversation }));
vi.mock("./gateQueueService.js", () => ({ enqueueGate, PRIVATE_REPLY_WINDOW_MS: 604800000 }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "bot-account", LOG_LEVEL: "info" } }));

const { backfillKeyword } = await import("./keywordBackfillService.js");

beforeEach(() => {
  keywordFindUnique.mockReset();
  eventLogFindMany.mockReset();
  conversationFindMany.mockReset();
  openConversation.mockReset();
  enqueueGate.mockReset();
  logEvent.mockReset();
});

describe("keywordBackfillService", () => {
  it("enqueues gates for candidate comments and includes mediaId", async () => {
    keywordFindUnique.mockResolvedValue({
      id: "kw-1",
      keyword: "SLEEP",
      active: true,
      mediaId: null,
      gateMessage: "Link here",
    });

    const commentTime = new Date("2026-08-06T10:00:00Z");
    eventLogFindMany.mockResolvedValue([
      {
        createdAt: commentTime,
        payload: {
          commentId: "comment-1",
          fromId: "user-1",
          text: "sleep please",
          mediaId: "media-123",
        },
      },
    ]);

    conversationFindMany.mockResolvedValue([]);
    openConversation.mockResolvedValue({ id: "convo-1" });
    enqueueGate.mockResolvedValue(undefined);

    const count = await backfillKeyword("kw-1");

    expect(count).toBe(1);
    expect(enqueueGate).toHaveBeenCalledWith({
      conversationId: "convo-1",
      igUserId: "user-1",
      commentId: "comment-1",
      mediaId: "media-123",
      gateMessage: "Link here",
      commentAt: commentTime,
    });
  });

  it("skips non-active or non-existent keywords", async () => {
    keywordFindUnique.mockResolvedValue(null);

    const count = await backfillKeyword("kw-1");
    expect(count).toBe(0);
    expect(eventLogFindMany).not.toHaveBeenCalled();
  });
});
