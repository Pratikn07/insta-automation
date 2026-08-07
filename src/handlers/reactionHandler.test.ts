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

  // An unknown action is not proof anyone engaged. Treating it as engagement
  // suppresses a legitimate reminder; the inverse — treating "react" as
  // nothing — lets a public comment reach someone who did engage.
  it.each([["unreact"], ["unknown_future_action"], [undefined]])(
    "records no engagement for action %s",
    async (action) => {
      await handleReaction({
        sender: { id: "user-1" },
        recipient: { id: "bot-1" },
        timestamp: 1786003200000,
        reaction: { mid: "mid-1", action: action as never, reaction: "love" },
      });

      expect(recordRecoveryReaction).not.toHaveBeenCalled();
    },
  );
});
