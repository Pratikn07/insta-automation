import { describe, it, expect, vi, beforeEach } from "vitest";

// One transaction client shared by every mocked model, so a test can assert the
// ORDER of calls inside a single transaction (which is where the supersede-then-
// insert invariant lives).
const tx = {
  dmMessage: { findUnique: vi.fn(), create: vi.fn() },
  dmThread: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  replyDraft: { updateMany: vi.fn() },
};

const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $transaction,
    dmMessage: tx.dmMessage,
    dmThread: tx.dmThread,
    replyDraft: tx.replyDraft,
  },
}));
vi.mock("../lib/logger.js", () => ({ logger }));

const {
  recordInboundMessage,
  recordOutboundMessage,
  updateDmThreadProfile,
  markThreadResolved,
} = await import("./dmThreadService.js");

const INBOUND = {
  igAccountId: "ig-account-1",
  igUserId: "ig-user-1",
  instagramMessageId: "mid-1",
  text: "Can you help with bedtime?",
  messageType: "text" as const,
  mediaUrl: null,
  instagramTimestamp: new Date("2026-08-04T10:00:00.000Z"),
};

beforeEach(() => {
  for (const model of Object.values(tx)) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  $transaction.mockClear();
  for (const fn of Object.values(logger)) fn.mockReset();
  tx.dmThread.upsert.mockResolvedValue({ id: "thread-1", latestInboundMessageId: null });
  tx.dmMessage.create.mockResolvedValue({ id: "message-1" });
  tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });
  tx.dmThread.update.mockResolvedValue({ id: "thread-1" });
  tx.dmThread.updateMany.mockResolvedValue({ count: 1 });
});

describe("recordInboundMessage", () => {
  it("returns duplicate without inserting when the Instagram mid is already stored", async () => {
    tx.dmMessage.findUnique.mockResolvedValue({ id: "message-1", threadId: "thread-1" });

    await expect(recordInboundMessage(INBOUND)).resolves.toEqual({
      duplicate: true,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(tx.dmMessage.create).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("records a fresh inbound, marks the thread needing a reply, and returns its ids", async () => {
    tx.dmMessage.findUnique.mockResolvedValue(null);

    await expect(recordInboundMessage(INBOUND)).resolves.toEqual({
      duplicate: false,
      becameLatest: true,
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(tx.dmThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "thread-1" },
        data: expect.objectContaining({
          latestInboundMessageId: "message-1",
          needsReply: true,
          lastInboundAt: INBOUND.instagramTimestamp,
          lastMessageAt: INBOUND.instagramTimestamp,
        }),
      }),
    );
  });

  it("supersedes active drafts BEFORE inserting the new message", async () => {
    tx.dmMessage.findUnique.mockResolvedValue(null);
    const order: string[] = [];
    tx.replyDraft.updateMany.mockImplementation(async () => {
      order.push("supersede");
      return { count: 1 };
    });
    tx.dmMessage.create.mockImplementation(async () => {
      order.push("insert");
      return { id: "message-1" };
    });

    await recordInboundMessage(INBOUND);

    expect(order).toEqual(["supersede", "insert"]);
  });

  it("supersedes only queued, generating and pending drafts — never one mid-send", async () => {
    tx.dmMessage.findUnique.mockResolvedValue(null);
    await recordInboundMessage(INBOUND);

    const [[call]] = tx.replyDraft.updateMany.mock.calls as [[{ where: { status: { in: string[] } } }]];
    expect(call.where.status.in).toEqual(["queued", "generating", "pending_approval"]);
    expect(call.where.status.in).not.toContain("sending");
  });

  it("does all of it inside one transaction", async () => {
    tx.dmMessage.findUnique.mockResolvedValue(null);
    await recordInboundMessage(INBOUND);
    expect($transaction).toHaveBeenCalledOnce();
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("stores a delayed older inbound without regressing latest state or superseding drafts", async () => {
    tx.dmThread.upsert.mockResolvedValue({
      id: "thread-1",
      latestInboundMessageId: "message-newer",
    });
    tx.dmMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        instagramMessageId: "mid-newer",
        instagramTimestamp: new Date("2026-08-05T10:00:00.000Z"),
      });
    const older = {
      ...INBOUND,
      instagramMessageId: "mid-older",
      instagramTimestamp: new Date("2026-08-05T09:59:59.000Z"),
    };

    await expect(recordInboundMessage(older)).resolves.toEqual({
      duplicate: false,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(tx.dmMessage.create).toHaveBeenCalledOnce();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.dmThread.update).not.toHaveBeenCalled();
  });

  it("uses the Instagram message ID to choose the latest inbound at equal timestamps", async () => {
    tx.dmThread.upsert.mockResolvedValue({
      id: "thread-1",
      latestInboundMessageId: "message-current",
    });
    tx.dmMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        instagramMessageId: "mid-a",
        instagramTimestamp: INBOUND.instagramTimestamp,
      });

    await expect(
      recordInboundMessage({ ...INBOUND, instagramMessageId: "mid-b" }),
    ).resolves.toMatchObject({ duplicate: false, becameLatest: true });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledOnce();
    expect(tx.dmThread.update).toHaveBeenCalledOnce();
  });

  it("retries a serialization conflict a bounded transaction attempt", async () => {
    tx.dmMessage.findUnique.mockResolvedValue(null);
    $transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(recordInboundMessage(INBOUND)).resolves.toMatchObject({
      duplicate: false,
      becameLatest: true,
    });
    expect($transaction).toHaveBeenCalledTimes(2);
  });
});

describe("recordOutboundMessage", () => {
  const OUTBOUND = {
    igAccountId: "ig-account-1",
    igUserId: "ig-user-1",
    instagramMessageId: "mid-out-1",
    text: "Here it is 💛",
    messageType: "text" as const,
    mediaUrl: null,
    source: "guide_automation" as const,
    instagramTimestamp: new Date("2026-08-04T10:05:00.000Z"),
  };

  it("updates outbound timestamps but never touches latestInboundMessageId or needsReply", async () => {
    await recordOutboundMessage(OUTBOUND);

    const [[call]] = tx.dmThread.update.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(call.data).toMatchObject({
      lastOutboundAt: OUTBOUND.instagramTimestamp,
      lastMessageAt: OUTBOUND.instagramTimestamp,
    });
    expect(call.data).not.toHaveProperty("latestInboundMessageId");
    expect(call.data).not.toHaveProperty("needsReply");
  });

  it("never throws, because it runs AFTER a successful Instagram send", async () => {
    // A logging failure here must not look like a send failure to the caller —
    // that is how a delivered message becomes a duplicate retry.
    $transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recordOutboundMessage(OUTBOUND)).resolves.toBeUndefined();
  });

  it("does not copy an outbound DM body from a database error into general logs", async () => {
    $transaction.mockRejectedValueOnce(new Error(`insert failed for ${OUTBOUND.text}`));

    await recordOutboundMessage(OUTBOUND);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "dm_history_write_failed",
        igUserId: OUTBOUND.igUserId,
        length: OUTBOUND.text.length,
      }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(OUTBOUND.text);
  });
});

describe("markThreadResolved", () => {
  it("clears needsReply only while the supplied inbound is still the latest", async () => {
    await markThreadResolved({ threadId: "thread-1", inboundMessageId: "message-1" });

    expect(tx.dmThread.updateMany).toHaveBeenCalledWith({
      where: { id: "thread-1", latestInboundMessageId: "message-1" },
      data: { needsReply: false },
    });
  });

  it("resolves nothing when a newer inbound has arrived", async () => {
    tx.dmThread.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      markThreadResolved({ threadId: "thread-1", inboundMessageId: "stale-message" }),
    ).resolves.toBeUndefined();
  });

  it("never throws — it trails a completed automation send", async () => {
    tx.dmThread.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      markThreadResolved({ threadId: "thread-1", inboundMessageId: "message-1" }),
    ).resolves.toBeUndefined();
  });
});

describe("updateDmThreadProfile", () => {
  it("stores the resolved username and name", async () => {
    await updateDmThreadProfile({ threadId: "thread-1", username: "geri", name: "Geri" });

    expect(tx.dmThread.updateMany).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { username: "geri", name: "Geri" },
    });
  });

  it("never throws — a profile lookup failure must not break message handling", async () => {
    tx.dmThread.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateDmThreadProfile({ threadId: "thread-1", username: null, name: null }),
    ).resolves.toBeUndefined();
  });
});
