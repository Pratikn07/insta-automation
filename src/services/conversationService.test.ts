import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const suppressRecoveriesForCompletion = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { conversation: { findFirst } },
}));
vi.mock("./dmRecoveryService.js", () => ({ suppressRecoveriesForCompletion }));

const { findLatestIncompleteConversation, hasCompletedKeyword, markCompleted } = await import(
  "./conversationService.js"
);

describe("findLatestIncompleteConversation", () => {
  beforeEach(() => findFirst.mockReset());

  it("selects the newest unfinished conversation without an age cutoff", async () => {
    findFirst.mockResolvedValue({ id: "expired-convo" });

    await findLatestIncompleteConversation("user-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        igUserId: "user-1",
        state: { in: ["awaiting_done", "expired"] },
      },
      orderBy: { createdAt: "desc" },
      include: { keyword: { include: { resource: { include: { messages: true } } } } },
    });
  });
});

describe("hasCompletedKeyword", () => {
  beforeEach(() => findFirst.mockReset());

  it("queries by keywordId, never by the keyword word", async () => {
    findFirst.mockResolvedValue(null);

    await hasCompletedKeyword("user-1", "kw-sleep-postA");

    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      igUserId: "user-1",
      keywordId: "kw-sleep-postA",
      state: "completed",
    });
    expect(where).not.toHaveProperty("keyword");
  });

  it("treats the same word on two posts as two separate guides", async () => {
    findFirst.mockResolvedValueOnce({ id: "convo-1" });
    expect(await hasCompletedKeyword("user-1", "kw-sleep-postA")).toBe(true);

    findFirst.mockResolvedValueOnce(null);
    expect(await hasCompletedKeyword("user-1", "kw-sleep-postB")).toBe(false);
  });

  it("still blocks a genuine repeat of the same post's keyword", async () => {
    findFirst.mockResolvedValue({ id: "convo-1" });

    expect(await hasCompletedKeyword("user-1", "kw-sleep-postA")).toBe(true);
  });
});

describe("markCompleted", () => {
  const conversationUpdate = vi.fn();
  const gateQueueUpdateMany = vi.fn();

  beforeEach(async () => {
    findFirst.mockReset();
    conversationUpdate.mockReset();
    gateQueueUpdateMany.mockReset();
    suppressRecoveriesForCompletion.mockReset();

    const { prisma } = await import("../lib/prisma.js");
    (prisma as any).$transaction = vi.fn(async (fn: Function) =>
      fn({
        conversation: { update: conversationUpdate },
        gateQueue: { updateMany: gateQueueUpdateMany },
      }),
    );
  });

  it("completes conversation, abandons pending gate queue rows, and suppresses recoveries", async () => {
    conversationUpdate.mockResolvedValue({
      id: "convo-1",
      igUserId: "ig-1",
      keywordId: "kw-1",
      state: "completed",
    });

    await markCompleted("convo-1");

    expect(conversationUpdate).toHaveBeenCalledWith({
      where: { id: "convo-1" },
      data: expect.objectContaining({ state: "completed", completedAt: expect.any(Date) }),
    });
    expect(gateQueueUpdateMany).toHaveBeenCalledWith({
      where: { conversationId: "convo-1", status: "pending" },
      data: { status: "abandoned", lastError: "conversation_completed" },
    });
    expect(suppressRecoveriesForCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "convo-1",
        igUserId: "ig-1",
        keywordId: "kw-1",
      }),
    );
  });
});
