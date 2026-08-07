import { describe, it, expect, vi, beforeEach } from "vitest";

const markOutboundSeen = vi.fn();
const recordRecoverySeen = vi.fn();

vi.mock("../services/dmThreadService.js", () => ({ markOutboundSeen }));
vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoverySeen }));
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

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

  // Recovery evidence keeps the earliest timestamp it has seen, so a seconds
  // epoch parsing to 1970 would pin this row's seenAt to 1970 forever. The
  // handler must fall back to receipt time instead of trusting the payload.
  it("does not let an implausible provider timestamp reach the evidence store", async () => {
    const secondsEpoch = 1786003200; // seconds, not milliseconds
    const before = Date.now();

    await handleSeen({
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: secondsEpoch,
      read: { mid: "mid-1" },
    });

    const [{ eventAt }] = recordRecoverySeen.mock.calls[0] as [{ eventAt: Date }];
    expect(eventAt.getUTCFullYear()).not.toBe(1970);
    expect(eventAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(markOutboundSeen).toHaveBeenCalledWith("mid-1", eventAt);
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
