import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { dmThread: { findMany, findUnique } },
}));

const { dmThreadsRouter } = await import("./dmThreads.routes.js");

function makeApp() {
  const app = express();
  app.use("/api/dm-threads", dmThreadsRouter);
  return app;
}

const messages = Array.from({ length: 201 }, (_, index) => {
  const n = index + 1;
  return {
    id: `message-${String(n).padStart(3, "0")}`,
    direction: "inbound",
    text: `message ${n}`,
    type: "text",
    source: "instagram_user",
    mediaUrl: null,
    instagramTimestamp: new Date(Date.UTC(2026, 7, 5, 10, 0, n)),
  };
});

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset().mockImplementation(async (args: {
    select: { messages: { orderBy: Array<Record<string, "asc" | "desc">>; take: number } };
  }) => {
    const direction = args.select.messages.orderBy[0]?.instagramTimestamp ?? "asc";
    const selected = [...messages]
      .sort((a, b) =>
        direction === "desc"
          ? b.instagramTimestamp.getTime() - a.instagramTimestamp.getTime()
          : a.instagramTimestamp.getTime() - b.instagramTimestamp.getTime(),
      )
      .slice(0, args.select.messages.take);
    return {
      id: "thread-1",
      igUserId: "ig-user-1",
      username: "geri",
      name: "Geri",
      needsReply: true,
      latestInboundMessageId: "message-201",
      lastMessageAt: messages[200]!.instagramTimestamp,
      messages: selected,
      drafts: [],
    };
  });
});

describe("GET /api/dm-threads/:threadId", () => {
  it("returns the newest 200 messages in chronological display order", async () => {
    const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);

    expect(response.body.messages).toHaveLength(200);
    expect(response.body.messages[0].id).toBe("message-002");
    expect(response.body.messages[199].id).toBe("message-201");
    expect(response.body.messages.map((message: { id: string }) => message.id)).not.toContain(
      "message-001",
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          drafts: expect.objectContaining({
            select: expect.objectContaining({
              kind: true,
              sourceConversationId: true,
              eligibleAt: true,
              expiresAt: true,
              promptVersion: true,
            }),
          }),
          messages: expect.objectContaining({
            orderBy: [{ instagramTimestamp: "desc" }, { id: "desc" }],
            take: 200,
          }),
        }),
      }),
    );
  });

  it("returns only bounded guide identity context for a follow-up", async () => {
    findUnique.mockResolvedValueOnce({
      id: "thread-1",
      igUserId: "ig-user-1",
      username: "geri",
      name: "Geri",
      needsReply: false,
      latestInboundMessageId: "message-201",
      lastMessageAt: messages[200]!.instagramTimestamp,
      messages: [],
      drafts: [
        {
          id: "follow-up-1",
          kind: "engagement_follow_up",
          status: "pending_approval",
          revision: 1,
          suggestedText: "How did bedtime go?",
          workingText: "How did bedtime go?",
          approvedText: null,
          rationale: "Asks one question.",
          confidence: "high",
          warnings: [],
          errorCode: null,
          errorMessage: null,
          retryAt: null,
          inboundMessageId: "message-201",
          sourceConversationId: "conversation-1",
          eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
          expiresAt: new Date("2026-08-06T09:15:00.000Z"),
          promptVersion: 1,
          approvedBy: null,
          approvedAt: null,
          sentAt: null,
          createdAt: new Date("2026-08-05T10:00:00.000Z"),
          sourceConversation: {
            id: "conversation-1",
            igUserId: "ig-user-1",
            keyword: {
              keyword: "S".repeat(120),
              resource: {
                name: "N".repeat(250),
                description: "D".repeat(700),
                kind: "K".repeat(80),
              },
            },
          },
        },
      ],
    });

    const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);

    expect(response.body.draft.sourceGuide).toEqual({
      name: "N".repeat(200),
      description: "D".repeat(500),
      kind: "K".repeat(64),
      keyword: "S".repeat(100),
    });
    expect(response.body.draft.promptPolicyCurrent).toBe(false);
    expect(response.body.draft).not.toHaveProperty("sourceConversation");
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          drafts: expect.objectContaining({
            select: expect.objectContaining({
              sourceConversation: {
                select: {
                  keyword: {
                    select: {
                      keyword: true,
                      resource: {
                        select: { name: true, description: true, kind: true },
                      },
                    },
                  },
                },
              },
            }),
          }),
        }),
      }),
    );
  });

  it("returns bounded safe guide-delivery reviews independent of the 200-message slice", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    findUnique.mockResolvedValueOnce({
      id: "thread-1",
      igUserId: "ig-user-1",
      username: "geri",
      name: "Geri",
      needsReply: true,
      latestInboundMessageId: "message-201",
      lastMessageAt: messages[200]!.instagramTimestamp,
      messages: [],
      drafts: [],
      guideDeliveries: [
        {
          id: "delivery-review-1",
          status: "needs_review",
          sendWindowExpiresAt: expiresAt,
          failureCode: "guide_unit_uncertain",
          units: [
            { id: "unit-sent", position: 0, kind: "text", status: "sent" },
            { id: "unit-uncertain", position: 1, kind: "image", status: "uncertain" },
          ],
        },
      ],
    });

    const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);

    expect(response.body.deliveryReviews).toEqual([
      {
        id: "delivery-review-1",
        status: "needs_review",
        confirmedUnits: 1,
        totalUnits: 2,
        sendWindowExpiresAt: expiresAt.toISOString(),
        sendWindowOpen: true,
        failureCode: "guide_unit_uncertain",
        units: [
          { id: "unit-sent", position: 0, kind: "text", status: "sent" },
          { id: "unit-uncertain", position: 1, kind: "image", status: "uncertain" },
        ],
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("textSnapshot");
    expect(JSON.stringify(response.body)).not.toContain("providerMessageId");

    const select = findUnique.mock.calls[0]?.[0].select;
    expect(select.messages.take).toBe(200);
    expect(select.guideDeliveries).toMatchObject({
      take: 10,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        sendWindowExpiresAt: true,
        failureCode: true,
        units: {
          orderBy: { position: "asc" },
          select: { id: true, position: true, kind: true, status: true },
        },
      },
    });
    const serializedSelector = JSON.stringify(select.guideDeliveries);
    for (const forbidden of [
      "textSnapshot",
      "mediaUrlSnapshot",
      "contentFingerprint",
      "providerMessageId",
      "errorTraceId",
      "errorCategory",
      "conversationId",
    ]) {
      expect(serializedSelector).not.toContain(forbidden);
    }
  });

  it("treats the send window as closed at exact equality using one request-time now", async () => {
    vi.useFakeTimers();
    const requestNow = new Date("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(requestNow);
    findUnique.mockResolvedValueOnce({
      id: "thread-1",
      igUserId: "ig-user-1",
      username: "geri",
      name: "Geri",
      needsReply: true,
      latestInboundMessageId: "message-201",
      lastMessageAt: messages[200]!.instagramTimestamp,
      messages: [],
      drafts: [],
      guideDeliveries: [{
        id: "delivery-review-closed",
        status: "failed",
        sendWindowExpiresAt: requestNow,
        failureCode: "messaging_window_closed",
        units: [{ id: "unit-failed", position: 0, kind: "text", status: "failed" }],
      }],
    });

    try {
      const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);
      expect(response.body.deliveryReviews[0].sendWindowOpen).toBe(false);
      expect(response.body.deliveryReviews[0]).not.toHaveProperty("windowOpen");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/dm-threads", () => {
  it("adds only an actionable delivery review count to list rows", async () => {
    findMany.mockResolvedValueOnce([{
      id: "thread-1",
      igUserId: "ig-user-1",
      username: "geri",
      name: "Geri",
      needsReply: true,
      latestInboundMessageId: "message-201",
      lastMessageAt: messages[200]!.instagramTimestamp,
      lastInboundAt: messages[200]!.instagramTimestamp,
      lastOutboundAt: null,
      messages: [],
      drafts: [],
      _count: { guideDeliveries: 2 },
    }]);

    const response = await request(makeApp()).get("/api/dm-threads").expect(200);

    expect(response.body.items[0]).toMatchObject({ deliveryReviewCount: 2 });
    expect(response.body.items[0]).not.toHaveProperty("guideDeliveries");
    expect(response.body.items[0]).not.toHaveProperty("_count");
    const select = findMany.mock.calls[0]?.[0].select;
    expect(select._count.select.guideDeliveries.where).toEqual({
      OR: [
        { status: "needs_review" },
        { status: "failed", failureCode: "messaging_window_closed" },
      ],
    });
    expect(select).not.toHaveProperty("guideDeliveries");
  });
});
