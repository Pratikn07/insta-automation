import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  replyDraft: {
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  dmThread: { findUnique: vi.fn() },
  dmMessage: { findMany: vi.fn() },
  conversation: { findUnique: vi.fn() },
};

const rootReplyDraft = {
  ...tx.replyDraft,
  findFirst: vi.fn(),
};

const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $transaction,
    replyDraft: rootReplyDraft,
    dmThread: tx.dmThread,
    dmMessage: tx.dmMessage,
    conversation: tx.conversation,
  },
}));

const {
  queueReplyDraft,
  claimOneQueuedDraft,
  expireDueFollowUps,
  loadDraftContext,
  completeGeneration,
  failGeneration,
  claimApprovedDraft,
  markSent,
  markSendFailed,
  markSendUncertain,
} = await import("./replyDraftService.js");
const { CURRENT_DM_PROMPT_VERSION } = await import("./replyDraftPolicy.js");

const INPUT = { threadId: "thread-1", inboundMessageId: "message-1" };

beforeEach(() => {
  for (const fn of Object.values(tx.replyDraft)) fn.mockReset();
  rootReplyDraft.findFirst.mockReset();
  tx.dmThread.findUnique.mockReset();
  tx.dmMessage.findMany.mockReset();
  tx.conversation.findUnique.mockReset();
  $transaction.mockClear();
  tx.replyDraft.aggregate.mockResolvedValue({ _max: { revision: null } });
  tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });
  tx.replyDraft.create.mockResolvedValue({ id: "draft-1", revision: 1, status: "queued" });
});

describe("queueReplyDraft", () => {
  it("allocates revision 1 for a thread's first draft", async () => {
    await queueReplyDraft(INPUT);

    expect(tx.replyDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-1",
          inboundMessageId: "message-1",
          revision: 1,
          status: "queued",
          kind: "reply",
          eligibleAt: expect.any(Date),
          nextAttemptAt: expect.any(Date),
          expiresAt: null,
          promptVersion: CURRENT_DM_PROMPT_VERSION,
          sourceConversationId: null,
        }),
      }),
    );
  });

  it("allocates max(revision)+1 so revisions never collide", async () => {
    tx.replyDraft.aggregate.mockResolvedValue({ _max: { revision: 4 } });
    await queueReplyDraft(INPUT);

    expect(tx.replyDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revision: 5 }) }),
    );
  });

  it("supersedes an older active draft before creating the new one", async () => {
    const order: string[] = [];
    tx.replyDraft.updateMany.mockImplementation(async () => {
      order.push("supersede");
      return { count: 1 };
    });
    tx.replyDraft.create.mockImplementation(async () => {
      order.push("create");
      return { id: "draft-2", revision: 2, status: "queued" };
    });

    await queueReplyDraft(INPUT);

    expect(order).toEqual(["supersede", "create"]);
    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ where: { status: { in: string[] } }; data: { status: string } }],
    ];
    expect(call.where.status.in).toEqual(["queued", "generating", "pending_approval"]);
    expect(call.data.status).toBe("superseded");
  });

  it("reloads the winner from the root client after a failed transaction rolls back", async () => {
    // Two webhooks for the same thread can race. The database's partial unique
    // index is the arbiter; the loser must return the winner rather than throw,
    // because both callers just want "the active draft for this thread".
    const uniqueViolation = Object.assign(new Error("unique constraint"), { code: "P2002" });
    const order: string[] = [];
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
      return { id: "draft-winner", revision: 1, status: "queued" };
    });

    await expect(queueReplyDraft(INPUT)).resolves.toMatchObject({ id: "draft-winner" });
    expect(order).toEqual(["rollback", "winner_lookup"]);
    expect(tx.replyDraft.findFirst).not.toHaveBeenCalled();
    expect(rootReplyDraft.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-1",
          status: { in: ["queued", "generating", "pending_approval"] },
        }),
      }),
    );
  });

  it("rethrows a unique violation when no active draft can be found", async () => {
    const uniqueViolation = Object.assign(new Error("unique constraint"), { code: "P2002" });
    tx.replyDraft.create.mockRejectedValue(uniqueViolation);
    rootReplyDraft.findFirst.mockResolvedValue(null);

    await expect(queueReplyDraft(INPUT)).rejects.toThrow("unique constraint");
  });

  it("runs revision allocation and supersession in one transaction", async () => {
    await queueReplyDraft(INPUT);
    expect($transaction).toHaveBeenCalledOnce();
  });
});

describe("claimOneQueuedDraft", () => {
  it("claims the oldest due draft by flipping queued -> generating with updateMany", async () => {
    const now = new Date("2026-08-05T22:00:00.000Z");
    tx.replyDraft.findFirst.mockResolvedValue({ id: "draft-1", threadId: "thread-1" });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      threadId: "thread-1",
      status: "generating",
    });

    const claimed = await claimOneQueuedDraft(now);

    expect(claimed).toMatchObject({ id: "draft-1", status: "generating" });
    // The claim is a conditional updateMany on status: queued — only the caller
    // that flips the single row owns it, so two ticks can't double-generate.
    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ where: { id: string; status: string }; data: { status: string } }],
    ];
    expect(call.where).toMatchObject({ id: "draft-1", status: "queued" });
    expect(call.data.status).toBe("generating");
    expect(tx.replyDraft.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "queued",
          eligibleAt: { lte: now },
          nextAttemptAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        }),
      }),
    );
  });

  it("returns null when no draft is due", async () => {
    tx.replyDraft.findFirst.mockResolvedValue(null);
    await expect(claimOneQueuedDraft()).resolves.toBeNull();
  });

  it("returns null when another worker won the claim (count 0)", async () => {
    tx.replyDraft.findFirst.mockResolvedValue({ id: "draft-1", threadId: "thread-1" });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimOneQueuedDraft()).resolves.toBeNull();
  });
});

describe("expireDueFollowUps", () => {
  it("expires every owner-review state whose follow-up window has closed", async () => {
    const now = new Date("2026-08-06T09:30:00.000Z");
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });

    await expect(expireDueFollowUps(now)).resolves.toBe(1);

    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        kind: "engagement_follow_up",
        status: {
          in: ["queued", "generating", "generation_failed", "pending_approval", "send_failed"],
        },
        expiresAt: { lte: now },
      },
      data: { status: "expired", errorCode: "follow_up_window_closed" },
    });
  });
});

describe("loadDraftContext", () => {
  const baseDraft = {
    id: "draft-1",
    threadId: "thread-1",
    kind: "reply" as const,
    sourceConversationId: null,
    expiresAt: null,
  };

  beforeEach(() => {
    tx.replyDraft.findUnique.mockResolvedValue({ status: "generating" });
    tx.dmThread.findUnique.mockResolvedValue({
      username: "geri",
      name: "Geri",
      igUserId: "ig-user-1",
    });
    tx.dmMessage.findMany.mockResolvedValue([
      {
        direction: "inbound",
        text: "latest",
        type: "text",
        source: "instagram_user",
        instagramTimestamp: new Date("2026-08-05T10:00:00.000Z"),
      },
      {
        direction: "outbound",
        text: "older",
        type: "text",
        source: "manual_external",
        instagramTimestamp: new Date("2026-08-05T09:00:00.000Z"),
      },
    ]);
  });

  it("returns reply context without looking up any guide", async () => {
    await expect(loadDraftContext(baseDraft)).resolves.toMatchObject({
      kind: "reply",
      guideDeliveredAt: null,
      guideContext: null,
      messages: [{ text: "older" }, { text: "latest" }],
    });
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
  });

  it("loads only the follow-up's exact delivered guide and completion time", async () => {
    tx.conversation.findUnique.mockResolvedValue({
      completedAt: new Date("2026-08-05T10:00:00.000Z"),
      keyword: {
        keyword: "SLEEP",
        resource: { name: "Sleep Guide", description: "A practical bedtime guide" },
      },
    });

    await expect(
      loadDraftContext({
        ...baseDraft,
        kind: "engagement_follow_up",
        sourceConversationId: "conversation-1",
        expiresAt: new Date("2026-08-06T09:30:00.000Z"),
      }),
    ).resolves.toMatchObject({
      kind: "engagement_follow_up",
      guideDeliveredAt: "2026-08-05T10:00:00.000Z",
      guideContext: {
        keyword: "SLEEP",
        resourceName: "Sleep Guide",
        description: "A practical bedtime guide",
      },
    });
    expect(tx.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      select: {
        completedAt: true,
        keyword: {
          select: {
            keyword: true,
            resource: { select: { name: true, description: true } },
          },
        },
      },
    });
  });

  it("uses the newest 20 messages, oldest-to-newest, within 8,000 characters", async () => {
    tx.dmMessage.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({
        direction: index % 2 === 0 ? "inbound" : "outbound",
        text: `${String(index).padStart(2, "0")}:${"x".repeat(496)}`,
        type: "text",
        source: "instagram_user",
        instagramTimestamp: new Date(Date.UTC(2026, 7, 5, 20 - index)),
      })),
    );

    const loaded = await loadDraftContext(baseDraft);

    expect(tx.dmMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { instagramTimestamp: "desc" },
        take: 20,
      }),
    );
    expect(loaded?.messages).toHaveLength(16);
    expect(loaded?.messages[0]?.text).toMatch(/^15:/);
    expect(loaded?.messages.at(-1)?.text).toMatch(/^00:/);
    expect(loaded?.messages.reduce((total, message) => total + (message.text?.length ?? 0), 0))
      .toBeLessThanOrEqual(8_000);
  });

  it("keeps one oversized database message inside the runtime's 2,000-character bound", async () => {
    tx.dmMessage.findMany.mockResolvedValue([
      {
        direction: "inbound",
        text: "x".repeat(9_000),
        type: "text",
        source: "instagram_user",
        instagramTimestamp: new Date("2026-08-05T10:00:00.000Z"),
      },
    ]);

    const loaded = await loadDraftContext(baseDraft);

    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.text).toHaveLength(2_000);
  });

  it("returns null after a newer inbound supersedes the generating draft", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({ status: "superseded" });

    await expect(loadDraftContext(baseDraft)).resolves.toBeNull();
    expect(tx.dmThread.findUnique).not.toHaveBeenCalled();
    expect(tx.dmMessage.findMany).not.toHaveBeenCalled();
  });

  it("rechecks generation state after context reads and drops mid-load supersession", async () => {
    tx.replyDraft.findUnique
      .mockResolvedValueOnce({ status: "generating" })
      .mockResolvedValueOnce({ status: "superseded" });

    await expect(loadDraftContext(baseDraft)).resolves.toBeNull();
    expect(tx.dmMessage.findMany).toHaveBeenCalledOnce();
  });
});

describe("completeGeneration", () => {
  const payload = {
    suggestedText: "Most toddlers keep a nap until around 3 💛",
    workingText: "Most toddlers keep a nap until around 3 💛",
    rationale: "Direct and warm.",
    confidence: "high",
    warnings: [],
    modelId: "codex-default",
  };

  it("transitions to pending_approval only while still generating and inbound unchanged", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      status: "generating",
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-1" });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });

    await completeGeneration("draft-1", payload);

    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ where: { id: string; status: string }; data: Record<string, unknown> }],
    ];
    expect(call.where).toMatchObject({ id: "draft-1", status: "generating" });
    expect(call.data).toMatchObject({
      status: "pending_approval",
      suggestedText: payload.suggestedText,
      workingText: payload.workingText,
    });
  });

  it("supersedes instead when a newer inbound arrived during generation", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      status: "generating",
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });
    // The thread has moved on to a later message.
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-2" });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });

    await completeGeneration("draft-1", payload);

    const statuses = tx.replyDraft.updateMany.mock.calls.map(
      ([c]) => (c as { data: { status: string } }).data.status,
    );
    expect(statuses).toContain("superseded");
    expect(statuses).not.toContain("pending_approval");
  });

  it("does nothing if the draft is no longer generating", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      status: "dismissed",
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });

    await completeGeneration("draft-1", payload);
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("expires an elapsed follow-up instead of exposing model output for approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T09:30:00.000Z"));
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      status: "generating",
      threadId: "thread-1",
      inboundMessageId: "message-1",
      kind: "engagement_follow_up",
      expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    });

    try {
      await completeGeneration("draft-1", payload);
    } finally {
      vi.useRealTimers();
    }

    expect(tx.dmThread.findUnique).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "generating" },
      data: { status: "expired", errorCode: "follow_up_window_closed" },
    });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "pending_approval" }) }),
    );
  });
});

describe("failGeneration", () => {
  it("moves generating -> generation_failed with a safe category", async () => {
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });

    await failGeneration("draft-1", {
      errorCode: "runtime_rate_limited",
      errorMessage: "ChatGPT usage limit reached",
      retryAt: new Date("2026-08-04T12:00:00.000Z"),
    });

    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ where: { id: string; status: string }; data: Record<string, unknown> }],
    ];
    expect(call.where).toMatchObject({ id: "draft-1", status: "generating" });
    expect(call.data).toMatchObject({
      status: "generation_failed",
      errorCode: "runtime_rate_limited",
    });
  });
});

// --- the approval boundary ---------------------------------------------------
// This is the only place in the product that causes an Instagram send from an AI
// suggestion, so the claim semantics are pinned hard.
describe("claimApprovedDraft", () => {
  const INPUT = {
    threadId: "thread-1",
    draftId: "draft-2",
    approvedBy: "owner@example.com",
    workingText: "This is the exact reply 💛",
  };

  beforeEach(() => {
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-2" });
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "pending_approval",
    });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
  });

  it("atomically claims only the latest pending draft and copies visible text", async () => {
    await claimApprovedDraft(INPUT);

    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        id: "draft-2",
        threadId: "thread-1",
        inboundMessageId: "message-2",
        status: "pending_approval",
      },
      data: expect.objectContaining({
        workingText: "This is the exact reply 💛",
        // approvedText is what actually goes to Instagram: exactly the text the
        // owner saw, never the model's original suggestion.
        approvedText: "This is the exact reply 💛",
        approvedBy: "owner@example.com",
        status: "sending",
      }),
    });
  });

  it("rejects an approval after a newer inbound message", async () => {
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-3" });

    await expect(claimApprovedDraft(INPUT)).rejects.toMatchObject({ code: "stale_draft" });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when the draft is no longer pending", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "dismissed",
    });

    await expect(claimApprovedDraft(INPUT)).rejects.toMatchObject({
      code: "draft_not_pending",
    });
  });

  it("rejects the loser of two parallel approvals (count 0)", async () => {
    // Both requests pass the pre-checks; the conditional updateMany is the arbiter,
    // so exactly one can win and the other must not send.
    tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimApprovedDraft(INPUT)).rejects.toMatchObject({
      code: "draft_not_pending",
    });
  });

  it("does not hold the transaction across any external call", async () => {
    // The claim transaction must END before Instagram is touched: a Graph request
    // can hang for a minute, and holding a Postgres transaction open that long
    // would exhaust the pool.
    await claimApprovedDraft(INPUT);
    expect($transaction).toHaveBeenCalledOnce();
  });
});

describe("send outcomes", () => {
  beforeEach(() => {
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
  });

  it("marks a confirmed delivery sent", async () => {
    await markSent("draft-2");
    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ where: { status: string }; data: Record<string, unknown> }],
    ];
    expect(call.where).toMatchObject({ id: "draft-2", status: "sending" });
    expect(call.data).toMatchObject({ status: "sent" });
  });

  it("marks a definite Graph error send_failed", async () => {
    await markSendFailed("draft-2", "graph_400");
    const [[call]] = tx.replyDraft.updateMany.mock.calls as [
      [{ data: { status: string; errorCode: string } }],
    ];
    expect(call.data.status).toBe("send_failed");
    expect(call.data.errorCode).toBe("graph_400");
  });

  it("marks an ambiguous timeout send_uncertain", async () => {
    // The message MAY have been delivered. This state exists so nothing retries
    // automatically and the owner is told to check Instagram first.
    await markSendUncertain("draft-2", "timeout");
    const [[call]] = tx.replyDraft.updateMany.mock.calls as [[{ data: { status: string } }]];
    expect(call.data.status).toBe("send_uncertain");
  });
});
