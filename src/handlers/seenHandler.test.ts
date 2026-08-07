import { describe, it, expect, vi, beforeEach } from "vitest";

const markOutboundSeen = vi.fn();
const recordRecoverySeen = vi.fn();

vi.mock("../services/dmThreadService.js", () => ({ markOutboundSeen }));
vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoverySeen }));
vi.mock("../lib/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

const { handleSeen } = await import("./seenHandler.js");

beforeEach(() => {
  markOutboundSeen.mockReset();
  recordRecoverySeen.mockReset();
});

describe("seenHandler", () => {
  it("calls markOutboundSeen and recordRecoverySeen with exact mid and timestamp", async () => {
    const timestamp = 1786003200000;
    await handleSeen({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp,
      read: { mid: "mid-1" },
    });

    expect(markOutboundSeen).toHaveBeenCalledWith("mid-1", new Date(timestamp));
    expect(recordRecoverySeen).toHaveBeenCalledWith({
      instagramMessageId: "mid-1",
      eventAt: new Date(timestamp),
      receivedAt: expect.any(Date),
    });
  });

  it("skips gracefully when mid is missing", async () => {
    await handleSeen({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      read: {},
    });

    expect(markOutboundSeen).not.toHaveBeenCalled();
    expect(recordRecoverySeen).not.toHaveBeenCalled();
  });
});
