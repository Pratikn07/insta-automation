import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTextMessage = vi.fn();
const sendPrivateReply = vi.fn();
const sendMedia = vi.fn();
const recordOutboundMessage = vi.fn();
const loggerError = vi.fn();

vi.mock("../meta/sendMessage.js", () => ({ sendTextMessage, sendPrivateReply }));
vi.mock("../meta/sendMedia.js", () => ({ sendMedia }));
vi.mock("./dmThreadService.js", () => ({ recordOutboundMessage }));
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError } }));

const { sendTrackedText, sendTrackedPrivateReply, sendTrackedMedia } = await import(
  "./dmDeliveryService.js"
);

beforeEach(() => {
  sendTextMessage.mockReset().mockResolvedValue({ messageId: "mid-1" });
  sendPrivateReply.mockReset().mockResolvedValue({ messageId: "mid-2" });
  sendMedia.mockReset().mockResolvedValue({ messageId: "mid-3" });
  recordOutboundMessage.mockReset().mockResolvedValue(undefined);
  loggerError.mockReset();
});

describe("sendTrackedText", () => {
  it("returns Meta's message id", async () => {
    await expect(
      sendTrackedText({
        recipientIgUserId: "ig-user-1",
        text: "Hello",
        source: "keyword_automation",
      }),
    ).resolves.toEqual({ messageId: "mid-1" });
  });

  // THE ordering rule of this service. A logging failure must never look like a
  // send failure: that is how a delivered gate DM once became 30+ duplicates.
  it("does not turn a successful Instagram send into a retry when recording fails", async () => {
    recordOutboundMessage.mockRejectedValue(new Error("database unavailable"));

    await expect(
      sendTrackedText({
        recipientIgUserId: "ig-user-1",
        text: "Hello",
        source: "keyword_automation",
      }),
    ).resolves.toEqual({ messageId: "mid-1" });

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(recordOutboundMessage).toHaveBeenCalledOnce();
  });

  it("logs only stable delivery metadata when the fallback itself catches a secret error", async () => {
    const sentinels = [
      "PRIVATE-DM-SENTINEL",
      "ACCESS-TOKEN-SENTINEL",
      "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
      "PROVIDER-MESSAGE-SENTINEL",
      "REQUEST-BODY-SENTINEL",
      "ARBITRARY-AXIOS-CODE-SENTINEL",
    ];
    recordOutboundMessage.mockRejectedValue(new Error(sentinels.join(" ")));

    await sendTrackedText({
      recipientIgUserId: "ig-user-1",
      text: "PRIVATE-DM-SENTINEL",
      source: "keyword_automation",
    });

    expect(loggerError).toHaveBeenCalledWith(
      {
        errorCode: "dm_history_write_failed",
        igUserId: "ig-user-1",
        instagramMessageId: "mid-1",
        source: "keyword_automation",
        length: "PRIVATE-DM-SENTINEL".length,
      },
      "Outbound DM was delivered but could not be recorded",
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const sentinel of sentinels) expect(captured).not.toContain(sentinel);
  });

  it("sends to Instagram BEFORE recording", async () => {
    const order: string[] = [];
    sendTextMessage.mockImplementation(async () => {
      order.push("instagram");
      return { messageId: "mid-1" };
    });
    recordOutboundMessage.mockImplementation(async () => {
      order.push("record");
    });

    await sendTrackedText({
      recipientIgUserId: "ig-user-1",
      text: "Hello",
      source: "guide_automation",
    });

    expect(order).toEqual(["instagram", "record"]);
  });

  it("does NOT record when the Instagram send itself fails", async () => {
    // Nothing was delivered, so there is nothing to record — and the caller's
    // existing error handling must still see the throw.
    sendTextMessage.mockRejectedValue(new Error("graph 400"));

    await expect(
      sendTrackedText({
        recipientIgUserId: "ig-user-1",
        text: "Hello",
        source: "keyword_automation",
      }),
    ).rejects.toThrow("graph 400");
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("records the exact text, source and returned id", async () => {
    await sendTrackedText({
      recipientIgUserId: "ig-user-1",
      text: "Here it is 💛",
      source: "ai_approved",
    });

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        igUserId: "ig-user-1",
        instagramMessageId: "mid-1",
        text: "Here it is 💛",
        messageType: "text",
        mediaUrl: null,
        source: "ai_approved",
      }),
    );
  });

  it("can defer history so an AI send is finalized in one strict transaction", async () => {
    await expect(
      sendTrackedText({
        recipientIgUserId: "ig-user-1",
        text: "Exact owner-approved text",
        source: "ai_approved",
        history: "deferred",
      }),
    ).resolves.toEqual({ messageId: "mid-1" });

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(sendTextMessage).toHaveBeenCalledWith("ig-user-1", "Exact owner-approved text");
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });
});

describe("sendTrackedPrivateReply", () => {
  it("records against the recipient, not the comment", async () => {
    // A private reply is addressed by comment_id, but it lands in the participant's
    // DM thread — so the recorded row must key on the user.
    await sendTrackedPrivateReply({
      recipientIgUserId: "ig-user-1",
      commentId: "comment-9",
      text: "Reply to your comment",
      source: "keyword_automation",
    });

    expect(sendPrivateReply).toHaveBeenCalledWith("comment-9", "Reply to your comment");
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ igUserId: "ig-user-1", instagramMessageId: "mid-2" }),
    );
  });

  it("survives a recording failure", async () => {
    recordOutboundMessage.mockRejectedValue(new Error("database unavailable"));
    await expect(
      sendTrackedPrivateReply({
        recipientIgUserId: "ig-user-1",
        commentId: "comment-9",
        text: "Reply",
        source: "keyword_automation",
      }),
    ).resolves.toEqual({ messageId: "mid-2" });
  });
});

describe("sendTrackedMedia", () => {
  it("maps a file attachment to the file message type and stores the url", async () => {
    await sendTrackedMedia({
      recipientIgUserId: "ig-user-1",
      type: "file",
      url: "https://example.com/guide.pdf",
      source: "guide_automation",
    });

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "file",
        mediaUrl: "https://example.com/guide.pdf",
        text: null,
        source: "guide_automation",
      }),
    );
  });

  it("maps an image attachment to the image message type", async () => {
    await sendTrackedMedia({
      recipientIgUserId: "ig-user-1",
      type: "image",
      url: "https://example.com/page.png",
      source: "guide_automation",
    });

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "image" }),
    );
  });

  it("survives a recording failure", async () => {
    recordOutboundMessage.mockRejectedValue(new Error("database unavailable"));
    await expect(
      sendTrackedMedia({
        recipientIgUserId: "ig-user-1",
        type: "image",
        url: "https://example.com/page.png",
        source: "guide_automation",
      }),
    ).resolves.toEqual({ messageId: "mid-3" });
  });
});
