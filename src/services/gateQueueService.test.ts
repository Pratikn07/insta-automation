import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const loggerError = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    gateQueue: { create },
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError },
}));

const { enqueueGate } = await import("./gateQueueService.js");

beforeEach(() => {
  create.mockReset();
  loggerError.mockReset();
});

describe("gateQueueService - enqueueGate", () => {
  it("creates a pending queue item with mediaId and default delay", async () => {
    await enqueueGate({
      conversationId: "convo-1",
      igUserId: "ig-1",
      commentId: "comment-1",
      mediaId: "media-1",
      gateMessage: "Here is your link",
      lastError: "graph_response",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "convo-1",
        igUserId: "ig-1",
        commentId: "comment-1",
        mediaId: "media-1",
        gateMessage: "Here is your link",
        status: "pending",
        attempts: 0,
        lastError: "graph_response",
        commentAt: expect.any(Date),
        nextAttemptAt: expect.any(Date),
      }),
    });
  });

  it("sets status to send_uncertain when initialErrorCategory is transport_uncertain or uncertain", async () => {
    await enqueueGate({
      conversationId: "convo-1",
      igUserId: "ig-1",
      commentId: "comment-1",
      gateMessage: "Link",
      initialErrorCategory: "transport_uncertain",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "send_uncertain",
      }),
    });
  });

  it("swallows error when DB insert fails and logs error", async () => {
    create.mockRejectedValue(new Error("DB failure"));

    await expect(
      enqueueGate({
        conversationId: "convo-1",
        igUserId: "ig-1",
        commentId: "comment-1",
        gateMessage: "Link",
      }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "gate_retry_enqueue_failed", commentId: "comment-1" },
      "Failed to enqueue gate retry",
    );
  });
});
