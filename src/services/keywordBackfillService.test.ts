import { describe, it, expect, vi, beforeEach } from "vitest";

const keywordFindUnique = vi.fn();
const eventLogFindMany = vi.fn();
const conversationFindMany = vi.fn();
const openConversationIn = vi.fn();
const resolveJourneyIntent = vi.fn();
const enqueueGate = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    keyword: { findUnique: keywordFindUnique },
    eventLog: { findMany: eventLogFindMany },
    conversation: { findMany: conversationFindMany },
  },
}));
vi.mock("./conversationService.js", () => ({ openConversationIn }));
// Contract-tested against real Postgres; here the backfill's contract is that it
// enqueues only for a journey it opened.
vi.mock("./journeyIntentService.js", () => ({ resolveJourneyIntent }));
vi.mock("./gateQueueService.js", () => ({ enqueueGate, PRIVATE_REPLY_WINDOW_MS: 604800000 }));
vi.mock("./eventLogger.js", () => ({ logEvent }));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "bot-account", LOG_LEVEL: "info" } }));

const { backfillKeyword } = await import("./keywordBackfillService.js");

beforeEach(() => {
  keywordFindUnique.mockReset();
  eventLogFindMany.mockReset();
  conversationFindMany.mockReset();
  openConversationIn.mockReset();
  resolveJourneyIntent.mockReset();
  resolveJourneyIntent.mockResolvedValue({
    disposition: "new_journey",
    intentId: "intent-1",
    conversationId: "convo-1",
    maySendGate: true,
  });
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
    openConversationIn.mockResolvedValue({ id: "convo-1" });
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

// The conversation filter upstream should already have removed these people, so
// this is the belt-and-braces case: a race, or a re-run overlapping the live path,
// must not enqueue a second gate for a journey that already has one.
it("enqueues nothing when the person already has a live journey", async () => {
  keywordFindUnique.mockResolvedValue({
    id: "kw-1",
    keyword: "SLEEP",
    active: true,
    mediaId: null,
    gateMessage: "Link here",
  });
  eventLogFindMany.mockResolvedValue([
    {
      createdAt: new Date("2026-08-06T10:00:00Z"),
      payload: { commentId: "comment-1", fromId: "user-1", text: "sleep please", mediaId: null },
    },
  ]);
  conversationFindMany.mockResolvedValue([]);
  openConversationIn.mockResolvedValue({ id: "convo-1" });

  resolveJourneyIntent.mockResolvedValue({
    disposition: "reused_active",
    intentId: "intent-1",
    conversationId: "convo-1",
    maySendGate: false,
  });

  const enqueued = await backfillKeyword("kw-1");

  expect(enqueued).toBe(0);
  expect(enqueueGate).not.toHaveBeenCalled();
  const kinds = logEvent.mock.calls.map(([kind]) => kind);
  expect(kinds).toContain("backfill_skipped_existing_journey");
});
