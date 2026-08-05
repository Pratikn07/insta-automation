import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  replyDraft: {
    aggregate: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
  },
};

const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));

vi.mock("../lib/prisma.js", () => ({
  prisma: { $transaction, replyDraft: tx.replyDraft },
}));

const { queueReplyDraft } = await import("./replyDraftService.js");

const INPUT = { threadId: "thread-1", inboundMessageId: "message-1" };

beforeEach(() => {
  for (const fn of Object.values(tx.replyDraft)) fn.mockReset();
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

  it("reloads the winning draft when the partial index rejects a concurrent insert", async () => {
    // Two webhooks for the same thread can race. The database's partial unique
    // index is the arbiter; the loser must return the winner rather than throw,
    // because both callers just want "the active draft for this thread".
    const uniqueViolation = Object.assign(new Error("unique constraint"), { code: "P2002" });
    tx.replyDraft.create.mockRejectedValue(uniqueViolation);
    tx.replyDraft.findFirst.mockResolvedValue({ id: "draft-winner", revision: 1, status: "queued" });

    await expect(queueReplyDraft(INPUT)).resolves.toMatchObject({ id: "draft-winner" });
    expect(tx.replyDraft.findFirst).toHaveBeenCalledWith(
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
    tx.replyDraft.findFirst.mockResolvedValue(null);

    await expect(queueReplyDraft(INPUT)).rejects.toThrow("unique constraint");
  });

  it("runs revision allocation and supersession in one transaction", async () => {
    await queueReplyDraft(INPUT);
    expect($transaction).toHaveBeenCalledOnce();
  });
});
