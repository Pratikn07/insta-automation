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
          messages: expect.objectContaining({
            orderBy: [{ instagramTimestamp: "desc" }, { id: "desc" }],
            take: 200,
          }),
        }),
      }),
    );
  });
});
