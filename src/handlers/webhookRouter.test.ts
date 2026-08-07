import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookPayload } from "../types/meta.js";

const handleComment = vi.fn();
const handleMessage = vi.fn();
const handleSeen = vi.fn();
const handleReaction = vi.fn();
const handlePostback = vi.fn();
const logEvent = vi.fn();
const SAFE_UNKNOWN = {
  category: "unknown_error",
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
};
const describeGraphError = vi.fn(() => SAFE_UNKNOWN);
const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock("./commentHandler.js", () => ({ handleComment }));
vi.mock("./messageHandler.js", () => ({ handleMessage }));
vi.mock("./seenHandler.js", () => ({ handleSeen }));
vi.mock("./reactionHandler.js", () => ({ handleReaction }));
vi.mock("./postbackHandler.js", () => ({ handlePostback }));
vi.mock("../services/eventLogger.js", () => ({
  logEvent,
  describeGraphError,
}));
vi.mock("../lib/logger.js", () => ({ logger }));

const { dispatchWebhook, routeMessagingEntry } = await import("./webhookRouter.js");

beforeEach(() => {
  handleComment.mockReset().mockResolvedValue(undefined);
  handleMessage.mockReset().mockResolvedValue(undefined);
  handleSeen.mockReset().mockResolvedValue(undefined);
  handleReaction.mockReset().mockResolvedValue(undefined);
  handlePostback.mockReset().mockResolvedValue(undefined);
  logEvent.mockReset().mockResolvedValue(undefined);
  describeGraphError.mockReset().mockReturnValue(SAFE_UNKNOWN);
  for (const fn of Object.values(logger)) fn.mockReset();
});

describe("dispatchWebhook", () => {
  it("records webhook counts without storing the raw payload or DM body", async () => {
    const privateBody = "private bedtime details";
    const payload: WebhookPayload = {
      object: "instagram",
      entry: [
        {
          id: "entry-1",
          time: 1785895200000,
          changes: [
            {
              field: "comments",
              value: { id: "comment-1", text: "public comment" },
            },
          ],
          messaging: [
            {
              sender: { id: "ig-user-1" },
              recipient: { id: "ig-account-1" },
              timestamp: 1785895200000,
              message: { mid: "mid-1", text: privateBody },
            },
          ],
        },
      ],
    };

    await dispatchWebhook(payload);

    expect(logEvent).toHaveBeenCalledWith("webhook_received", {
      object: "instagram",
      entryCount: 1,
      messagingCount: 1,
      changeCount: 1,
    });
    const webhookPayload = logEvent.mock.calls.find(([kind]) => kind === "webhook_received")?.[1];
    expect(webhookPayload).not.toHaveProperty("payload");
    expect(JSON.stringify(webhookPayload)).not.toContain(privateBody);
  });

  it("reports a message-handler failure without copying DM or backend error content", async () => {
    const privateBody = "private webhook DM body";
    const payload: WebhookPayload = {
      object: "instagram",
      entry: [
        {
          id: "entry-1",
          time: 1785895200000,
          messaging: [
            {
              sender: { id: "ig-user-1" },
              recipient: { id: "ig-account-1" },
              timestamp: 1785895200000,
              message: { mid: "mid-1", text: privateBody },
            },
          ],
        },
      ],
    };
    handleMessage.mockRejectedValue(new Error(`database rejected ${privateBody}`));

    await dispatchWebhook(payload);

    const errorEvent = logEvent.mock.calls.find(([kind]) => kind === "error")?.[1];
    expect(errorEvent).toEqual({
      stage: "messageHandler",
      senderId: "ig-user-1",
      errorCode: "message_handler_failed",
      ...SAFE_UNKNOWN,
    });
    expect(JSON.stringify({ logs: logger.error.mock.calls, errorEvent })).not.toContain(privateBody);
  });
});

describe("routeMessagingEntry single dispatch", () => {
  it.each([
    ["read/seen", { read: { mid: "out-1" } }, handleSeen],
    ["reaction", { reaction: { mid: "out-1", action: "react", reaction: "love" } }, handleReaction],
    ["postback", { postback: { mid: "out-1", payload: "OPEN_GUIDE" } }, handlePostback],
    ["message", { message: { mid: "in-1", text: "DONE" } }, handleMessage],
  ])("routes one %s entry once to the appropriate handler", async (_name, payload, expectedHandler) => {
    const entry = {
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1785895200000,
      ...payload,
    };
    await routeMessagingEntry(entry);
    expect(expectedHandler).toHaveBeenCalledOnce();
  });

  it("prioritizes quick_reply inside message as a message event", async () => {
    const entry = {
      sender: { id: "user-1" },
      recipient: { id: "bot-1" },
      timestamp: 1785895200000,
      message: { mid: "in-1", text: "DONE", quick_reply: { payload: "DONE_PAYLOAD" } },
    };
    await routeMessagingEntry(entry);
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(handlePostback).not.toHaveBeenCalled();
  });
});
