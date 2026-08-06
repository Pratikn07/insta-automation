import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
const sendTrackedText = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { replyDraft: { updateMany } } }));
vi.mock("./dmDeliveryService.js", () => ({ sendTrackedText }));

const { runReplyDraftRecoveryTick } = await import("./replyDraftRecoveryWorker.js");

describe("runReplyDraftRecoveryTick", () => {
  beforeEach(() => {
    updateMany.mockReset();
    sendTrackedText.mockReset();
    updateMany.mockResolvedValue({ count: 2 });
  });

  it("moves sending rows stale for 15 minutes to terminal send_uncertain", async () => {
    const now = new Date("2026-08-05T12:30:00.000Z");

    await expect(runReplyDraftRecoveryTick(now)).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: "sending",
        updatedAt: { lte: new Date("2026-08-05T12:15:00.000Z") },
      },
      data: {
        status: "send_uncertain",
        errorCode: "send_state_recovered_after_restart",
        failedAt: now,
      },
    });
  });

  it("never calls Instagram while reconciling an uncertain send", async () => {
    await runReplyDraftRecoveryTick(new Date("2026-08-05T12:30:00.000Z"));
    expect(sendTrackedText).not.toHaveBeenCalled();
  });
});
