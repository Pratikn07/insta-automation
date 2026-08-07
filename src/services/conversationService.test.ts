import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const suppressRecoveriesForCompletionSafely = vi.fn();
const markIntentCompleted = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { conversation: { findFirst } },
}));
vi.mock("./dmRecoveryService.js", () => ({ suppressRecoveriesForCompletionSafely }));
vi.mock("./journeyIntentService.js", () => ({ markIntentCompleted }));

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
    suppressRecoveriesForCompletionSafely.mockReset();

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
    expect(suppressRecoveriesForCompletionSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "convo-1",
        igUserId: "ig-1",
        keywordId: "kw-1",
      }),
    );
  });

  // Suppression ran inside the completion transaction, so a failure there rolled
  // back the completion AND the gate abandon. The gate worker abandons a row
  // only when the conversation reads `completed`, so the row stayed pending and
  // re-sent "reply DONE to unlock" to someone who already had the guide.
  it("keeps the completion when suppressing recoveries fails", async () => {
    conversationUpdate.mockResolvedValue({
      id: "convo-1",
      igUserId: "ig-1",
      keywordId: "kw-1",
      state: "completed",
    });
    suppressRecoveriesForCompletionSafely.mockRejectedValue(new Error("recovery table unavailable"));

    await expect(markCompleted("convo-1")).rejects.toThrow("recovery table unavailable");

    // Both writes were committed before suppression was attempted, so neither
    // is rolled back by its failure.
    expect(conversationUpdate).toHaveBeenCalledWith({
      where: { id: "convo-1" },
      data: expect.objectContaining({ state: "completed" }),
    });
    expect(gateQueueUpdateMany).toHaveBeenCalledWith({
      where: { conversationId: "convo-1", status: "pending" },
      data: { status: "abandoned", lastError: "conversation_completed" },
    });
  });

  it("suppresses outside the completion transaction", async () => {
    conversationUpdate.mockResolvedValue({
      id: "convo-1",
      igUserId: "ig-1",
      keywordId: "kw-1",
      state: "completed",
    });

    const { prisma } = await import("../lib/prisma.js");
    let txOpen = false;
    (prisma as any).$transaction = vi.fn(async (fn: Function) => {
      txOpen = true;
      const result = await fn({
        conversation: { update: conversationUpdate },
        gateQueue: { updateMany: gateQueueUpdateMany },
      });
      txOpen = false;
      return result;
    });
    suppressRecoveriesForCompletionSafely.mockImplementation(async () => {
      expect(txOpen).toBe(false);
    });

    await markCompleted("convo-1");

    expect(suppressRecoveriesForCompletionSafely).toHaveBeenCalledTimes(1);
  });
});
