import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  dmThread: { findUnique: vi.fn() },
  conversation: { updateMany: vi.fn() },
  replyDraft: {
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
};

const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
const rootReplyDraft = { findFirst: vi.fn() };

vi.mock("../lib/prisma.js", () => ({ prisma: { $transaction, replyDraft: rootReplyDraft } }));

const { scheduleEngagementFollowUp } = await import("./engagementFollowUpService.js");
const { CURRENT_DM_PROMPT_VERSION } = await import("./replyDraftPolicy.js");

const INPUT = {
  conversationId: "conversation-1",
  threadId: "thread-1",
  inboundMessageId: "message-1",
  inboundAt: new Date("2026-08-05T09:45:00.000Z"),
  deliveredAt: new Date("2026-08-05T10:00:00.000Z"),
};

beforeEach(() => {
  $transaction.mockClear();
  rootReplyDraft.findFirst.mockReset();
  for (const group of Object.values(tx)) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  tx.conversation.updateMany.mockResolvedValue({ count: 1 });
  tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-1" });
  tx.replyDraft.aggregate.mockResolvedValue({ _max: { revision: null } });
  tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
  tx.replyDraft.create.mockResolvedValue({ id: "follow-up-1", status: "queued" });
});

describe("scheduleEngagementFollowUp", () => {
  it("queues one versioned follow-up linked to the delivered conversation at the policy times", async () => {
    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: true,
      draftId: "follow-up-1",
    });

    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conversation-1", engagementFollowUpScheduledAt: null },
      data: { engagementFollowUpScheduledAt: expect.any(Date) },
    });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        inboundMessageId: "message-1",
        status: { in: ["queued", "generating", "pending_approval"] },
      },
      data: { status: "superseded" },
    });
    expect(tx.replyDraft.create).toHaveBeenCalledWith({
      data: {
        threadId: "thread-1",
        inboundMessageId: "message-1",
        revision: 1,
        status: "queued",
        kind: "engagement_follow_up",
        sourceConversationId: "conversation-1",
        eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
        nextAttemptAt: new Date("2026-08-05T22:00:00.000Z"),
        expiresAt: new Date("2026-08-06T09:15:00.000Z"),
        promptVersion: CURRENT_DM_PROMPT_VERSION,
      },
    });
  });

  it("does not claim or create when the 12-hour delay falls outside the inbound window", async () => {
    await expect(
      scheduleEngagementFollowUp({
        ...INPUT,
        deliveredAt: new Date("2026-08-06T09:00:00.000Z"),
      }),
    ).resolves.toEqual({ scheduled: false, draftId: null });

    expect(tx.dmThread.findUnique).toHaveBeenCalledOnce();
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("converges a retry or concurrent scheduler when the conversation was already claimed", async () => {
    tx.conversation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: true,
      draftId: "follow-up-1",
    });
    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: false,
      draftId: null,
    });

    expect(tx.replyDraft.create).toHaveBeenCalledOnce();
  });

  it("does not claim or derive timing from an inbound that is no longer latest", async () => {
    // The older handler finished a slow guide send after Task 3 had already
    // accepted a newer genuine inbound for the same thread.
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-new" });

    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: false,
      draftId: null,
    });

    expect(tx.dmThread.findUnique).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      select: { latestInboundMessageId: true },
    });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.aggregate).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("retries the complete latest-inbound check after a serializable race", async () => {
    const serializationConflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    $transaction.mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => {
      await fn(tx); // writes are rolled back when the serializable transaction aborts
      tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-new" });
      throw serializationConflict;
    });

    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: false,
      draftId: null,
    });

    expect($transaction).toHaveBeenCalledTimes(2);
    expect(tx.dmThread.findUnique).toHaveBeenCalledTimes(2);
    // Only the rolled-back first attempt reached creation; the retry saw the
    // newer inbound before claim/timing writes and returned without another one.
    expect(tx.replyDraft.create).toHaveBeenCalledOnce();
  });

  it("allocates the next thread revision inside the scheduling transaction", async () => {
    tx.replyDraft.aggregate.mockResolvedValue({ _max: { revision: 7 } });

    await scheduleEngagementFollowUp(INPUT);

    expect(tx.replyDraft.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ revision: 8 }),
    });
    expect($transaction).toHaveBeenCalledOnce();
  });

  it("reloads a concurrent conversation-linked winner only after rollback", async () => {
    const order: string[] = [];
    const uniqueViolation = Object.assign(new Error("unique constraint"), { code: "P2002" });
    tx.replyDraft.create.mockRejectedValue(uniqueViolation);
    $transaction.mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => {
      try {
        return await fn(tx);
      } catch (error) {
        order.push("rollback");
        throw error;
      }
    });
    rootReplyDraft.findFirst.mockImplementation(async () => {
      order.push("winner_lookup");
      return { id: "follow-up-winner" };
    });

    await expect(scheduleEngagementFollowUp(INPUT)).resolves.toEqual({
      scheduled: true,
      draftId: "follow-up-winner",
    });
    expect(order).toEqual(["rollback", "winner_lookup"]);
    expect(rootReplyDraft.findFirst).toHaveBeenCalledWith({
      where: {
        sourceConversationId: "conversation-1",
        kind: "engagement_follow_up",
        status: { in: ["queued", "generating", "pending_approval"] },
      },
      orderBy: { revision: "desc" },
    });
  });
});
