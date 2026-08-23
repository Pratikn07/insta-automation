import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const debug = vi.fn();

vi.mock("./graphClient.js", () => ({ graph: { post } }));
vi.mock("../config/env.js", () => ({ env: { IG_USER_ID: "ig-account" } }));
vi.mock("../lib/logger.js", () => ({ logger: { debug } }));

const { sendMetaMessage, sendPrivateReply, sendTextMessage } = await import("./sendMessage.js");

beforeEach(() => {
  post.mockReset().mockResolvedValue({ data: { message_id: "mid-1" } });
  debug.mockReset();
});

describe("sendMetaMessage", () => {
  it("posts one payload and logs allowlisted delivery metadata only", async () => {
    const copy = "COPY-SENTINEL";
    const payload = `ts:guide:3f05a514-1f04-4b14-9df4-7730c7c39af4`;
    const url = "https://www.instagram.com/tinysoho/";

    await expect(
      sendMetaMessage(
        {
          recipient: { id: "17890000000000002" },
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "generic",
                elements: [
                  {
                    title: copy,
                    image_url: url,
                    buttons: [{ type: "postback", title: "Yes", payload }],
                  },
                ],
              },
            },
          },
        },
        { recipientId: "17890000000000002", mode: "dm_quick_reply", messageLength: copy.length },
      ),
    ).resolves.toEqual({ messageId: "mid-1" });

    expect(post).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      {
        recipientId: "17890000000000002",
        mode: "dm_quick_reply",
        messageLength: copy.length,
        providerMessageId: "mid-1",
      },
      "Sent Meta message",
    );
    const logged = JSON.stringify(debug.mock.calls);
    for (const forbidden of [copy, payload, url, "attachment", "quick_replies"]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it("keeps the established text and private-reply senders on the common safe boundary", async () => {
    await sendTextMessage("17890000000000002", "Hello");
    await sendPrivateReply("17890000000000001", "Private hello");

    expect(post).toHaveBeenNthCalledWith(1, "/ig-account/messages", {
      recipient: { id: "17890000000000002" },
      message: { text: "Hello" },
    });
    expect(post).toHaveBeenNthCalledWith(2, "/ig-account/messages", {
      recipient: { comment_id: "17890000000000001" },
      message: { text: "Private hello" },
    });
    expect(debug).toHaveBeenNthCalledWith(
      1,
      {
        recipientId: "17890000000000002",
        mode: "text",
        messageLength: 5,
        providerMessageId: "mid-1",
      },
      "Sent Meta message",
    );
    expect(debug).toHaveBeenNthCalledWith(
      2,
      {
        commentId: "17890000000000001",
        mode: "private_text",
        messageLength: 13,
        providerMessageId: "mid-1",
      },
      "Sent Meta message",
    );
  });
});
