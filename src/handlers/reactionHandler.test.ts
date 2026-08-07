import { describe, it, expect, vi, beforeEach } from "vitest";

const recordRecoveryReaction = vi.fn();

vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoveryReaction }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { handleReaction } = await import("./reactionHandler.js");

beforeEach(() => {
  recordRecoveryReaction.mockReset();
});

describe("reactionHandler", () => {
  it("records recovery reaction for action react", async () => {
    const timestamp = 1786003200000;
    await handleReaction({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp,
      reaction: { mid: "mid-1", action: "react", reaction: "love" },
    });

    expect(recordRecoveryReaction).toHaveBeenCalledWith({
      instagramMessageId: "mid-1",
      eventAt: new Date(timestamp),
      receivedAt: expect.any(Date),
    });
  });

  it("does not call recordRecoveryReaction for action unreact", async () => {
    await handleReaction({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      reaction: { mid: "mid-1", action: "unreact" },
    });

    expect(recordRecoveryReaction).not.toHaveBeenCalled();
  });

  it("skips gracefully when mid is missing", async () => {
    await handleReaction({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      reaction: { action: "react" },
    });

    expect(recordRecoveryReaction).not.toHaveBeenCalled();
  });
});
