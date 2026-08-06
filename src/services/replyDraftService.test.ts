import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  replyDraft: {
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  dmThread: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  dmMessage: { findMany: vi.fn(), create: vi.fn() },
  conversation: { findUnique: vi.fn() },
  eventLog: { create: vi.fn() },
};

const rootReplyDraft = {
  ...tx.replyDraft,
  findFirst: vi.fn(),
};
const rootExecuteRaw = vi.fn();

const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $transaction,
    $executeRaw: rootExecuteRaw,
    replyDraft: rootReplyDraft,
    dmThread: tx.dmThread,
    dmMessage: tx.dmMessage,
    conversation: tx.conversation,
    eventLog: tx.eventLog,
  },
}));

const {
  queueReplyDraft,
  regenerateReplyDraft,
  claimOneQueuedDraft,
  expireDueFollowUps,
  loadDraftContext,
  completeGeneration,
  failGeneration,
  claimApprovedDraft,
  claimRetryDraft,
  finalizeApprovedDraftSend,
  markSent,
  markSendFailed,
  markSendUncertain,
} = await import("./replyDraftService.js");
const { CURRENT_DM_PROMPT_VERSION } = await import("./replyDraftPolicy.js");

const INPUT = { threadId: "thread-1", inboundMessageId: "message-1" };

beforeEach(() => {
  tx.$executeRaw.mockReset();
  tx.$queryRaw.mockReset();
  for (const fn of Object.values(tx.replyDraft)) fn.mockReset();
  rootReplyDraft.findFirst.mockReset();
  rootExecuteRaw.mockReset().mockResolvedValue(0);
  for (const fn of Object.values(tx.dmThread)) fn.mockReset();
  for (const fn of Object.values(tx.dmMessage)) fn.mockReset();
  tx.conversation.findUnique.mockReset();
  tx.eventLog.create.mockReset();
  $transaction.mockReset().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  tx.replyDraft.aggregate.mockResolvedValue({ _max: { revision: null } });
  tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });
  tx.$executeRaw.mockResolvedValue(1);
  tx.$queryRaw.mockResolvedValue([{ id: "draft-2" }]);
  tx.replyDraft.create.mockResolvedValue({ id: "draft-1", revision: 1, status: "queued" });
});

describe("queueReplyDraft", () => {
  const LOCKED_THREAD = {
    id: "thread-1",
    latestInboundMessageId: "message-1",
    needsReply: true,
  };

  beforeEach(() => {
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"') && sql.includes("FOR UPDATE")) {
        return [LOCKED_THREAD];
      }
      return [];
    });
  });

  it("locks the thread first and creates from its authoritative latest inbound", async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"') && sql.includes("FOR UPDATE")) {
        order.push("thread_lock");
        return [{ ...LOCKED_THREAD, latestInboundMessageId: "message-current" }];
      }
      return [];
    });
    tx.replyDraft.aggregate.mockImplementation(async () => {
      order.push("revision");
      return { _max: { revision: null } };
    });
    tx.replyDraft.updateMany.mockImplementation(async () => {
      order.push("supersede");
      return { count: 0 };
    });
    tx.replyDraft.create.mockImplementation(async ({ data }) => {
      order.push("create");
      return { id: "draft-current", ...data };
    });

    await expect(queueReplyDraft({ threadId: "thread-1" })).resolves.toMatchObject({
      id: "draft-current",
      inboundMessageId: "message-current",
    });

    expect(order).toEqual(["thread_lock", "revision", "supersede", "create"]);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("rejects a slow older handler after a newer inbound becomes authoritative", async () => {
    tx.$queryRaw.mockResolvedValue([
      { ...LOCKED_THREAD, latestInboundMessageId: "message-new" },
    ]);

    await expect(queueReplyDraft(INPUT)).rejects.toMatchObject({ code: "stale_draft" });

    expect(tx.replyDraft.aggregate).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("refuses creation when the locked thread no longer needs a reply", async () => {
    tx.$queryRaw.mockResolvedValue([{ ...LOCKED_THREAD, needsReply: false }]);

    await expect(queueReplyDraft(INPUT)).rejects.toMatchObject({
      code: "thread_not_needing_reply",
    });

    expect(tx.replyDraft.aggregate).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("bounds serializable retries and rechecks the locked thread each time", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), {
      code: "P2034",
    });
    $transaction.mockRejectedValueOnce(serializationFailure);

    await expect(queueReplyDraft(INPUT)).resolves.toMatchObject({ id: "draft-1" });
    expect($transaction).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();

    $transaction.mockReset().mockRejectedValue(serializationFailure);
    await expect(queueReplyDraft(INPUT)).rejects.toBe(serializationFailure);
    expect($transaction).toHaveBeenCalledTimes(3);
  });

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

describe("regenerateReplyDraft", () => {
  const INPUT = { threadId: "thread-1", draftId: "draft-1" };
  const THREAD_ROW = {
    id: "thread-1",
    latestInboundMessageId: "message-1",
    igUserId: "ig-user-1",
  };
  const FOLLOW_UP_ROW = {
    threadId: "thread-1",
    inboundMessageId: "message-1",
    status: "pending_approval",
    kind: "engagement_follow_up",
    sourceConversationId: "conversation-1",
    eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
    expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    promptVersion: CURRENT_DM_PROMPT_VERSION,
    sourceIgUserId: "ig-user-1",
    sourceCompletedAt: new Date("2026-08-05T10:00:00.000Z"),
    isEligible: true,
    isUnexpired: true,
  };
  let lockedThread = THREAD_ROW;
  let lockedDraft = FOLLOW_UP_ROW;
  let boundaryWins = true;

  function sqlAt(index: number): string {
    return (tx.$queryRaw.mock.calls[index]?.[0] as TemplateStringsArray).join("?");
  }

  beforeEach(() => {
    lockedThread = THREAD_ROW;
    lockedDraft = FOLLOW_UP_ROW;
    boundaryWins = true;
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"') && sql.includes("FOR UPDATE")) {
        return [lockedThread];
      }
      if (sql.includes('FROM "reply_draft" AS draft') && sql.includes("FOR UPDATE OF draft")) {
        return [lockedDraft];
      }
      if (sql.includes('INSERT INTO "reply_draft"')) {
        return boundaryWins ? [{ id: "draft-4" }] : [];
      }
      return [];
    });
    tx.replyDraft.findFirst.mockResolvedValue(null);
    tx.replyDraft.findUnique.mockResolvedValue({ id: "draft-4", status: "queued" });
  });

  it("locks thread then draft and preserves source/timing at one guarded boundary", async () => {
    await expect(regenerateReplyDraft(INPUT)).resolves.toMatchObject({
      id: "draft-4",
      status: "queued",
    });

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(sqlAt(0)).toContain('FROM "dm_thread"');
    expect(sqlAt(0)).toContain("FOR UPDATE");
    expect(sqlAt(0)).not.toContain('JOIN "reply_draft"');
    expect(sqlAt(1)).toContain('FROM "reply_draft" AS draft');
    expect(sqlAt(1)).toContain("FOR UPDATE OF draft");
    expect(sqlAt(1)).not.toContain("FOR UPDATE OF draft, thread");

    const boundarySql = sqlAt(2);
    expect(boundarySql).toContain('UPDATE "reply_draft" AS draft');
    expect(boundarySql).toContain('INSERT INTO "reply_draft"');
    expect(boundarySql).toContain('thread."latest_inbound_message_id" = draft."inbound_message_id"');
    expect(boundarySql).toContain('source."completed_at" IS NOT NULL');
    expect(boundarySql).toContain('source."ig_user_id" = thread."ig_user_id"');
    expect(boundarySql).toContain('draft."source_conversation_id"');
    expect(boundarySql).toContain('draft."eligible_at"');
    expect(boundarySql).toContain('draft."expires_at"');
    expect(boundarySql.match(/"expires_at" > clock_timestamp\(\)/g)).toHaveLength(2);
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it.each([
    ["superseded", { status: "superseded" }, {}, "draft_not_pending"],
    ["stale inbound", {}, { latestInboundMessageId: "message-2" }, "stale_draft"],
    ["old policy", { promptVersion: CURRENT_DM_PROMPT_VERSION - 1 }, {}, "prompt_policy_outdated"],
    ["not eligible", { isEligible: false }, {}, "follow_up_not_ready"],
    ["wrong source user", { sourceIgUserId: "ig-user-2" }, {}, "stale_draft"],
    ["unfinished source", { sourceCompletedAt: null }, {}, "stale_draft"],
  ])("rejects %s after both locks and before the guarded boundary", async (_case, draft, thread, code) => {
    lockedDraft = { ...FOLLOW_UP_ROW, ...draft };
    lockedThread = { ...THREAD_ROW, ...thread };

    await expect(regenerateReplyDraft(INPUT)).rejects.toMatchObject({ code });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("commits expiry without superseding or creating a replacement", async () => {
    lockedDraft = { ...FOLLOW_UP_ROW, isUnexpired: false };
    tx.$executeRaw.mockResolvedValue(1);

    await expect(regenerateReplyDraft(INPUT)).rejects.toMatchObject({
      code: "follow_up_window_closed",
    });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
    const expirySql = (tx.$executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    expect(expirySql).toContain('"status" = \'expired\'');
    expect(expirySql).toContain('"expires_at" <= clock_timestamp()');
  });

  it("rolls back the boundary and commits expiry when the deadline crosses before create", async () => {
    boundaryWins = false;
    rootExecuteRaw.mockResolvedValue(1);

    await expect(regenerateReplyDraft(INPUT)).rejects.toMatchObject({
      code: "follow_up_window_closed",
    });

    expect(tx.replyDraft.findUnique).not.toHaveBeenCalled();
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
    expect(rootExecuteRaw).toHaveBeenCalledOnce();
    const expirySql = (rootExecuteRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    expect(expirySql).toContain('"status" = \'expired\'');
    expect(expirySql).toContain('"expires_at" <= clock_timestamp()');
    expect(expirySql).toContain('"status" =');
    expect(expirySql).toContain('"inbound_message_id" =');
  });

  it("does not supersede a newer active reply when a failed follow-up is retried", async () => {
    lockedDraft = { ...FOLLOW_UP_ROW, status: "generation_failed" };
    tx.replyDraft.findFirst.mockResolvedValue({ id: "reply-new" });

    await expect(regenerateReplyDraft(INPUT)).rejects.toMatchObject({ code: "stale_draft" });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
    expect(tx.replyDraft.create).not.toHaveBeenCalled();
  });

  it("retries P2034 in a fresh thread-then-draft transaction", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "P2034" });
    $transaction.mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => {
      await fn(tx);
      throw serializationFailure;
    });

    await expect(regenerateReplyDraft(INPUT)).resolves.toMatchObject({ id: "draft-4" });

    expect($transaction).toHaveBeenCalledTimes(2);
    const sql = tx.$queryRaw.mock.calls.map((call) => (call[0] as TemplateStringsArray).join("?"));
    expect(
      sql.filter((value) => value.includes('FROM "dm_thread"') && value.includes("FOR UPDATE")),
    ).toHaveLength(2);
    expect(sql.filter((value) => value.includes("FOR UPDATE OF draft"))).toHaveLength(2);
  });

  it("bounds repeated P2034 retries", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), { code: "P2034" });
    $transaction.mockRejectedValue(serializationFailure);

    await expect(regenerateReplyDraft(INPUT)).rejects.toBe(serializationFailure);
    expect($transaction).toHaveBeenCalledTimes(3);
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

  it("fails context safely when a follow-up source has no confirmed delivery time", async () => {
    tx.conversation.findUnique.mockResolvedValue({
      completedAt: null,
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
    ).resolves.toBeNull();
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
        orderBy: [
          { instagramTimestamp: "desc" },
          { instagramMessageId: "desc" },
        ],
        take: 20,
      }),
    );
    expect(loaded?.messages).toHaveLength(16);
    expect(loaded?.messages[0]?.text).toMatch(/^15:/);
    expect(loaded?.messages.at(-1)?.text).toMatch(/^00:/);
    expect(loaded?.messages.reduce((total, message) => total + (message.text?.length ?? 0), 0))
      .toBeLessThanOrEqual(8_000);
  });

  it("uses Meta message ID to deterministically order tied Instagram timestamps", async () => {
    const tiedAt = new Date("2026-08-05T10:00:00.000Z");
    tx.dmMessage.findMany.mockResolvedValue([
      {
        direction: "inbound",
        text: "second",
        type: "text",
        source: "instagram_user",
        instagramMessageId: "mid-b",
        instagramTimestamp: tiedAt,
      },
      {
        direction: "inbound",
        text: "first",
        type: "text",
        source: "instagram_user",
        instagramMessageId: "mid-a",
        instagramTimestamp: tiedAt,
      },
    ]);

    const loaded = await loadDraftContext(baseDraft);

    expect(tx.dmMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { instagramTimestamp: "desc" },
          { instagramMessageId: "desc" },
        ],
        take: 20,
      }),
    );
    expect(loaded?.messages.map((message) => message.text)).toEqual(["first", "second"]);
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

  it("expires when the deadline-safe final approval transition loses at write time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T09:14:59.900Z"));
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-1",
      status: "generating",
      threadId: "thread-1",
      inboundMessageId: "message-1",
      kind: "engagement_follow_up",
      expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    });
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-1" });
    // Simulates Postgres evaluating clock_timestamp() after the deadline and
    // refusing the final guarded pending_approval write.
    tx.$executeRaw.mockResolvedValue(0);
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });

    try {
      await completeGeneration("draft-1", payload);
    } finally {
      vi.useRealTimers();
    }

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const sql = (tx.$executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    expect(sql).toContain('"expires_at" > clock_timestamp()');
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: { id: "draft-1", status: "generating", kind: "engagement_follow_up" },
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
  const NOW = new Date("2026-08-05T12:00:00.000Z");
  const BEFORE_ELIGIBILITY = new Date("2026-08-05T11:59:59.999Z");
  const AFTER_EXPIRY = new Date("2026-08-05T13:00:00.000Z");
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
      kind: "reply",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
      expiresAt: null,
    });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
  });

  it("atomically claims only the latest pending draft and copies visible text", async () => {
    await expect(claimApprovedDraft(INPUT, NOW)).resolves.toEqual({
      approvedText: "This is the exact reply 💛",
      inboundMessageId: "message-2",
    });

    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        id: "draft-2",
        threadId: "thread-1",
        inboundMessageId: "message-2",
        status: "pending_approval",
        kind: "reply",
        promptVersion: CURRENT_DM_PROMPT_VERSION,
        thread: { latestInboundMessageId: "message-2" },
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
      kind: "reply",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
      expiresAt: null,
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

  it.each([null, CURRENT_DM_PROMPT_VERSION - 1, CURRENT_DM_PROMPT_VERSION + 1])(
    "rejects non-current prompt policy version %s",
    async (promptVersion) => {
      tx.replyDraft.findUnique.mockResolvedValue({
        id: "draft-2",
        threadId: "thread-1",
        inboundMessageId: "message-2",
        status: "pending_approval",
        kind: "reply",
        promptVersion,
        eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
        expiresAt: null,
      });

      await expect(claimApprovedDraft(INPUT, NOW)).rejects.toMatchObject({
        code: "prompt_policy_outdated",
      });
      expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("rejects a follow-up before eligibility", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "pending_approval",
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T12:00:00.000Z"),
      expiresAt: AFTER_EXPIRY,
    });

    await expect(claimApprovedDraft(INPUT, BEFORE_ELIGIBILITY)).rejects.toMatchObject({
      code: "follow_up_not_ready",
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    new Date("2026-08-05T13:00:00.000Z"),
    new Date("2026-08-05T13:00:00.001Z"),
  ])("rejects a follow-up at or after expiry (%s)", async (attemptedAt) => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "pending_approval",
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T12:00:00.000Z"),
      expiresAt: AFTER_EXPIRY,
    });
    tx.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(claimApprovedDraft(INPUT, attemptedAt)).rejects.toMatchObject({
      code: "follow_up_window_closed",
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the database clock in the final follow-up claim so a deadline race cannot send", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "pending_approval",
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T11:00:00.000Z"),
      expiresAt: AFTER_EXPIRY,
    });
    tx.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(claimApprovedDraft(INPUT, NOW)).rejects.toMatchObject({
      code: "follow_up_window_closed",
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const claimSql = (tx.$executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    const lockSql = (tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    const finalBoundarySql = claimSql;
    expect(lockSql).toContain("FOR UPDATE");
    expect(lockSql).not.toContain('draft."status"');
    expect(lockSql).not.toContain('draft."prompt_version"');
    expect(lockSql).not.toContain('draft."kind"');
    expect(finalBoundarySql).toContain('draft."thread_id" = ?::uuid');
    expect(finalBoundarySql).toContain('draft."inbound_message_id" = ?::uuid');
    expect(finalBoundarySql).toContain('draft."status" = \'pending_approval\'');
    expect(finalBoundarySql).toContain('draft."prompt_version" = ?');
    expect(finalBoundarySql).toContain('draft."kind" = \'engagement_follow_up\'');
    expect(finalBoundarySql).toContain('draft."expires_at" > clock_timestamp()');
    expect(finalBoundarySql).toContain('draft."eligible_at" <= clock_timestamp()');
    expect(finalBoundarySql).toContain('thread."latest_inbound_message_id" = draft."inbound_message_id"');
    const expirySql = (tx.$executeRaw.mock.calls[1]?.[0] as TemplateStringsArray).join("?");
    expect(expirySql).toContain('"status" = \'expired\'');
    expect(expirySql).toContain('"expires_at" <= clock_timestamp()');
  });

  it("allows only one of two parallel approval claims", async () => {
    tx.replyDraft.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      claimApprovedDraft(INPUT, NOW),
      claimApprovedDraft(INPUT, NOW),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "draft_not_pending" }),
    });
  });
});

describe("claimRetryDraft", () => {
  const NOW = new Date("2026-08-05T12:00:00.000Z");
  const AFTER_EXPIRY = new Date("2026-08-05T13:00:00.000Z");
  const RETRY_INPUT = {
    threadId: "thread-1",
    draftId: "draft-2",
    confirmedNotDelivered: true as const,
  };

  beforeEach(() => {
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-2" });
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "send_uncertain",
      kind: "reply",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
      expiresAt: null,
      approvedText: "Previously approved exact text",
    });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
  });

  it("atomically reclaims a retryable draft and returns only its approved text", async () => {
    await expect(claimRetryDraft(RETRY_INPUT, NOW)).resolves.toEqual({
      approvedText: "Previously approved exact text",
      inboundMessageId: "message-2",
    });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        id: "draft-2",
        threadId: "thread-1",
        inboundMessageId: "message-2",
        status: { in: ["send_failed", "send_uncertain"] },
        kind: "reply",
        promptVersion: CURRENT_DM_PROMPT_VERSION,
        thread: { latestInboundMessageId: "message-2" },
      },
      data: { status: "sending", errorCode: null },
    });
  });

  it("rejects a legacy retry before changing state", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "send_failed",
      kind: "reply",
      promptVersion: null,
      eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
      expiresAt: null,
      approvedText: "Legacy approved text",
    });

    await expect(claimRetryDraft(RETRY_INPUT, NOW)).rejects.toMatchObject({
      code: "prompt_policy_outdated",
    });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a follow-up retry after expiry", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "send_failed",
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T11:00:00.000Z"),
      expiresAt: AFTER_EXPIRY,
      approvedText: "Follow-up text",
    });
    tx.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(claimRetryDraft(RETRY_INPUT, AFTER_EXPIRY)).rejects.toMatchObject({
      code: "follow_up_window_closed",
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("checks every mutable retry requirement after acquiring the follow-up row lock", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "send_uncertain",
      kind: "engagement_follow_up",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T11:00:00.000Z"),
      expiresAt: AFTER_EXPIRY,
      approvedText: "Follow-up text",
    });
    tx.$executeRaw.mockResolvedValueOnce(1);

    await expect(claimRetryDraft(RETRY_INPUT, NOW)).resolves.toEqual({
      approvedText: "Follow-up text",
      inboundMessageId: "message-2",
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const claimSql = (tx.$executeRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    const lockSql = (tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join("?");
    const finalBoundarySql = claimSql;
    expect(lockSql).toContain("FOR UPDATE");
    expect(lockSql).not.toContain('draft."status"');
    expect(lockSql).not.toContain('draft."prompt_version"');
    expect(lockSql).not.toContain('draft."kind"');
    expect(finalBoundarySql).toContain('draft."thread_id" = ?::uuid');
    expect(finalBoundarySql).toContain('draft."inbound_message_id" = ?::uuid');
    expect(finalBoundarySql).toContain('draft."status" IN (\'send_failed\', \'send_uncertain\')');
    expect(finalBoundarySql).toContain('draft."prompt_version" = ?');
    expect(finalBoundarySql).toContain('draft."kind" = \'engagement_follow_up\'');
    expect(finalBoundarySql).toContain('draft."approved_text" = ?');
    expect(finalBoundarySql).toContain('draft."expires_at" > clock_timestamp()');
    expect(finalBoundarySql).toContain('draft."eligible_at" <= clock_timestamp()');
    expect(finalBoundarySql).toContain('thread."latest_inbound_message_id" = draft."inbound_message_id"');
  });

  it("rejects a retry after a newer genuine inbound", async () => {
    tx.dmThread.findUnique.mockResolvedValue({ latestInboundMessageId: "message-3" });

    await expect(claimRetryDraft(RETRY_INPUT, NOW)).rejects.toMatchObject({
      code: "stale_draft",
    });
    expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a draft outside the explicit failure states", async () => {
    tx.replyDraft.findUnique.mockResolvedValue({
      id: "draft-2",
      threadId: "thread-1",
      inboundMessageId: "message-2",
      status: "sent",
      kind: "reply",
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      eligibleAt: new Date("2026-08-05T00:00:00.000Z"),
      expiresAt: null,
      approvedText: "Already sent",
    });

    await expect(claimRetryDraft(RETRY_INPUT, NOW)).rejects.toMatchObject({
      code: "draft_not_retryable",
    });
  });
});

describe("finalizeApprovedDraftSend", () => {
  const sentAt = new Date("2026-08-05T12:34:56.000Z");
  const approvedText = "The exact owner-approved reply 💛";
  const input = {
    draftId: "draft-2",
    threadId: "thread-1",
    inboundMessageId: "message-2",
    instagramMessageId: "mid-confirmed-1",
    approvedText,
    approvedBy: "owner@example.com",
    sentAt,
  };

  beforeEach(() => {
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"')) {
        return [{ id: "thread-1", latestInboundMessageId: "message-2" }];
      }
      if (sql.includes('FROM "reply_draft"')) {
        return [
          {
            id: "draft-2",
            threadId: "thread-1",
            inboundMessageId: "message-2",
            status: "sending",
            approvedText,
          },
        ];
      }
      return [];
    });
    tx.dmMessage.create.mockResolvedValue({ id: "outbound-row-1" });
    tx.replyDraft.updateMany.mockResolvedValue({ count: 1 });
    tx.dmThread.update.mockResolvedValue({ id: "thread-1" });
    tx.dmThread.updateMany.mockResolvedValue({ count: 1 });
    tx.eventLog.create.mockResolvedValue({ id: "event-1" });
  });

  it("atomically stores the exact outbound, sent state, conditional resolution, and body-free audit", async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"')) {
        order.push("thread_lock");
        return [{ id: "thread-1", latestInboundMessageId: "message-2" }];
      }
      order.push("draft_lock");
      return [
        {
          id: "draft-2",
          threadId: "thread-1",
          inboundMessageId: "message-2",
          status: "sending",
          approvedText,
        },
      ];
    });
    tx.dmMessage.create.mockImplementation(async () => {
      order.push("outbound");
      return { id: "outbound-row-1" };
    });
    tx.replyDraft.updateMany.mockImplementation(async () => {
      order.push("sent");
      return { count: 1 };
    });
    tx.dmThread.update.mockImplementation(async () => {
      order.push("thread_timestamps");
      return { id: "thread-1" };
    });
    tx.dmThread.updateMany.mockImplementation(async () => {
      order.push("conditional_resolve");
      return { count: 1 };
    });
    tx.eventLog.create.mockImplementation(async () => {
      order.push("audit");
      return { id: "event-1" };
    });

    await finalizeApprovedDraftSend(input);

    expect(order).toEqual([
      "thread_lock",
      "draft_lock",
      "outbound",
      "sent",
      "thread_timestamps",
      "conditional_resolve",
      "audit",
    ]);
    expect(tx.dmMessage.create).toHaveBeenCalledWith({
      data: {
        threadId: "thread-1",
        instagramMessageId: "mid-confirmed-1",
        direction: "outbound",
        type: "text",
        source: "ai_approved",
        text: approvedText,
        mediaUrl: null,
        instagramTimestamp: sentAt,
      },
    });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        id: "draft-2",
        threadId: "thread-1",
        inboundMessageId: "message-2",
        status: "sending",
        approvedText,
      },
      data: {
        status: "sent",
        sentAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    expect(tx.dmThread.updateMany).toHaveBeenCalledWith({
      where: { id: "thread-1", latestInboundMessageId: "message-2" },
      data: { needsReply: false },
    });
    expect(tx.eventLog.create).toHaveBeenCalledWith({
      data: {
        kind: "ai_reply_sent",
        payload: {
          threadId: "thread-1",
          draftId: "draft-2",
          by: "owner@example.com",
          length: approvedText.length,
          instagramMessageId: "mid-confirmed-1",
        },
      },
    });
    expect(JSON.stringify(tx.eventLog.create.mock.calls)).not.toContain(approvedText);
  });

  it("rejects before writing when the locked draft no longer exactly matches", async () => {
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "dm_thread"')) {
        return [{ id: "thread-1", latestInboundMessageId: "message-2" }];
      }
      return [
        {
          id: "draft-2",
          threadId: "thread-1",
          inboundMessageId: "message-2",
          status: "send_uncertain",
          approvedText,
        },
      ];
    });

    await expect(finalizeApprovedDraftSend(input)).rejects.toThrow("send_state_not_recorded");
    expect(tx.dmMessage.create).not.toHaveBeenCalled();
    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });

  it("propagates an audit failure so the whole strict finalization transaction rolls back", async () => {
    tx.eventLog.create.mockRejectedValue(new Error("audit unavailable"));

    await expect(finalizeApprovedDraftSend(input)).rejects.toThrow("audit unavailable");
    expect(tx.dmMessage.create).toHaveBeenCalledOnce();
    expect(tx.replyDraft.updateMany).toHaveBeenCalledOnce();
    expect(tx.eventLog.create).toHaveBeenCalledOnce();
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

  it("rejects when confirmed delivery cannot be recorded from sending", async () => {
    tx.replyDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(markSent("draft-2")).rejects.toThrow("send_state_not_recorded");
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
