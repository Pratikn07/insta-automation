import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const findAccessReviews = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmThread: { findMany, findUnique },
    guideAccessAttempt: { findMany: findAccessReviews },
  },
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
  findAccessReviews.mockReset().mockResolvedValue([]);
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
      guideDeliveries: [],
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/dm-threads", () => {
  it("returns only a delivery review count and selects no private delivery fields", async () => {
    findMany.mockResolvedValueOnce([
      {
        id: "thread-1",
        igUserId: "ig-user-1",
        username: "geri",
        name: "Geri",
        needsReply: true,
        latestInboundMessageId: "message-201",
        lastMessageAt: messages[200]!.instagramTimestamp,
        lastInboundAt: messages[200]!.instagramTimestamp,
        lastOutboundAt: null,
        messages: [messages[200]],
        drafts: [],
        _count: { guideDeliveries: 2 },
      },
    ]);

    const response = await request(makeApp()).get("/api/dm-threads").expect(200);

    expect(response.body.items[0]).toMatchObject({ deliveryReviewCount: 2 });
    expect(response.body.items[0]).toMatchObject({ accessReviewCount: 0 });
    expect(response.body.items[0]).not.toHaveProperty("_count");
    expect(response.body.items[0]).not.toHaveProperty("guideDeliveries");
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("textSnapshot");
    expect(serialized).not.toContain("mediaUrlSnapshot");
    expect(serialized).not.toContain("providerMessageId");
    expect(serialized).not.toContain("errorTraceId");

    const select = findMany.mock.calls[0]![0].select;
    expect(select._count).toEqual({
      select: {
        guideDeliveries: {
          where: expect.objectContaining({ OR: expect.any(Array) }),
        },
      },
    });
    expect(select).not.toHaveProperty("guideDeliveries");
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

  it("returns a separate bounded guide-access review for the same Instagram user", async () => {
    findAccessReviews.mockResolvedValueOnce([
      {
        id: "10000000-0000-4000-8000-000000000001",
        conversationId: "20000000-0000-4000-8000-000000000002",
        state: "needs_review",
        lastFollowResult: "unknown",
        followCheckCount: 5,
        followResponseCount: 3,
        messagingWindowExpiresAt: new Date("2026-08-26T12:00:00.000Z"),
        conversation: { igUserId: "ig-user-1" },
        resource: { name: "R".repeat(250) },
      },
    ]);

    const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);

    expect(response.body.accessReviews).toEqual([
      expect.objectContaining({
        attemptId: "10000000-0000-4000-8000-000000000001",
        conversationId: "20000000-0000-4000-8000-000000000002",
        resourceName: "R".repeat(200),
        state: "needs_review",
        canRelease: true,
      }),
    ]);
    const serialized = JSON.stringify(response.body.accessReviews);
    expect(serialized).not.toMatch(/token|coverUrl|provider|message|errorTrace/i);
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
      guideDeliveries: [],
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

  it("returns bounded newest-first aggregate review DTOs queried directly through the thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
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
          id: "delivery-newest",
          status: "needs_review",
          sendWindowExpiresAt: new Date("2026-08-17T12:00:01.000Z"),
          failureCode: null,
          createdAt: new Date("2026-08-17T11:59:00.000Z"),
          textSnapshot: "PRIVATE-LATER-DELIVERY-SNAPSHOT",
          providerMessageId: "PRIVATE-PROVIDER-ID",
          units: [
            {
              id: "unit-1",
              position: 0,
              kind: "text",
              origin: "resource_step",
              status: "sent",
              textSnapshot: "PRIVATE-UNIT-SNAPSHOT",
              mediaUrlSnapshot: "https://private.example.test/media",
              contentFingerprint: "f".repeat(64),
              providerMessageId: "provider-private",
              errorTraceId: "trace-private",
            },
            {
              id: "unit-2",
              position: 1,
              kind: "image",
              origin: "generated_cover",
              status: "uncertain",
              textSnapshot: null,
              mediaUrlSnapshot: "https://private.example.test/media",
              contentFingerprint: "e".repeat(64),
              providerMessageId: null,
              errorTraceId: "trace-private",
            },
          ],
        },
        {
          id: "delivery-older-closed",
          status: "failed",
          sendWindowExpiresAt: new Date("2026-08-17T11:59:59.000Z"),
          failureCode: "messaging_window_closed",
          createdAt: new Date("2026-08-17T11:00:00.000Z"),
          units: [
            { id: "unit-3", position: 0, kind: "file", origin: "resource_step", status: "pending" },
          ],
        },
      ],
    });

    const response = await request(makeApp()).get("/api/dm-threads/thread-1").expect(200);

    expect(response.body.deliveryReviews).toEqual([
      {
        id: "delivery-newest",
        status: "needs_review",
        confirmedUnits: 1,
        totalUnits: 2,
        sendWindowExpiresAt: "2026-08-17T12:00:01.000Z",
        sendWindowOpen: true,
        failureCode: null,
        units: [
          { id: "unit-1", position: 0, kind: "text", origin: "resource_step", status: "sent" },
          // A generated cover is not one of the owner's authored steps, and the review
          // surface has to be able to say so without ever seeing the cover's URL.
          { id: "unit-2", position: 1, kind: "image", origin: "generated_cover", status: "uncertain" },
        ],
      },
      {
        id: "delivery-older-closed",
        status: "failed",
        confirmedUnits: 0,
        totalUnits: 1,
        sendWindowExpiresAt: "2026-08-17T11:59:59.000Z",
        sendWindowOpen: false,
        failureCode: "messaging_window_closed",
        units: [
          { id: "unit-3", position: 0, kind: "file", origin: "resource_step", status: "pending" },
        ],
      },
    ]);
    const serialized = JSON.stringify(response.body.deliveryReviews);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("textSnapshot");
    expect(serialized).not.toContain("mediaUrlSnapshot");
    expect(serialized).not.toContain("contentFingerprint");
    expect(serialized).not.toContain("providerMessageId");
    expect(serialized).not.toContain("errorTraceId");

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread-1" },
        select: expect.objectContaining({
          messages: expect.objectContaining({ take: 200 }),
          guideDeliveries: {
            where: expect.objectContaining({ OR: expect.any(Array) }),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: expect.any(Number),
            select: {
              id: true,
              status: true,
              sendWindowExpiresAt: true,
              failureCode: true,
              units: {
                orderBy: { position: "asc" },
                select: { id: true, position: true, kind: true, origin: true, status: true },
              },
            },
          },
        }),
      }),
    );
  });
});
