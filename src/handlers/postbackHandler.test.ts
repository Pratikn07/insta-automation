import { describe, it, expect, vi, beforeEach } from "vitest";

const recordRecoveryPostback = vi.fn();

vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoveryPostback }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { handlePostback } = await import("./postbackHandler.js");

beforeEach(() => {
  recordRecoveryPostback.mockReset();
});

describe("postbackHandler", () => {
  it("records recovery postback when mid is present", async () => {
    const timestamp = 1786003200000;
    await handlePostback({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp,
      postback: { mid: "mid-1", payload: "OPEN" },
    });

    expect(recordRecoveryPostback).toHaveBeenCalledWith({
      instagramMessageId: "mid-1",
      eventAt: new Date(timestamp),
      receivedAt: expect.any(Date),
    });
  });

  it("acknowledges without evidence write when mid is missing", async () => {
    await handlePostback({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      postback: { payload: "OPEN" },
    });

    expect(recordRecoveryPostback).not.toHaveBeenCalled();
  });
});
