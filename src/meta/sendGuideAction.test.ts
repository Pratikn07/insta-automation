import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMetaMessage = vi.fn();

vi.mock("./sendMessage.js", () => ({ sendMetaMessage }));

const {
  GUIDE_PROFILE_URL,
  sendGuideFollowerGate,
  sendGuideFollowLag,
  sendGuideInitialPrivateReply,
} =
  await import("./sendGuideAction.js");

const COMMENT_ID = "17890000000000001";
const RECIPIENT_ID = "17890000000000002";
const ACTION_TOKEN = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
const ACTION_PAYLOAD = `ts:guide:${ACTION_TOKEN}`;
const COVER_URL = "https://cdn.example.com/guide-cover/sleep/dm.png";
const OPENING =
  "Got it 💛 I've got the toddler sleep guide you asked for. Want me to send it here?";
// Text mode carries no control, so it asks for the short reply instead.
const OPENING_TEXT = `${OPENING} Reply YES and I'll send it over.`;

beforeEach(() => {
  sendMetaMessage.mockReset().mockResolvedValue({ messageId: "mid-1" });
});

describe("sendGuideInitialPrivateReply", () => {
  it("uses the text-only private-reply fallback before Meta is contacted when rich capability is unproven", async () => {
    await sendGuideInitialPrivateReply({
      commentId: COMMENT_ID,
      guideName: "toddler sleep guide",
      actionToken: ACTION_TOKEN,
    });

    expect(sendMetaMessage).toHaveBeenCalledOnce();
    expect(sendMetaMessage).toHaveBeenCalledWith(
      { recipient: { comment_id: COMMENT_ID }, message: { text: OPENING_TEXT } },
      { commentId: COMMENT_ID, mode: "private_text", messageLength: OPENING_TEXT.length },
    );
  });

  it("uses the proven private quick-reply payload without a second private reply", async () => {
    await sendGuideInitialPrivateReply({
      commentId: COMMENT_ID,
      guideName: "toddler sleep guide",
      actionToken: ACTION_TOKEN,
      capabilities: { privateQuickReply: true, dmGenericGate: false },
    });

    expect(sendMetaMessage).toHaveBeenCalledOnce();
    expect(sendMetaMessage).toHaveBeenCalledWith(
      {
        recipient: { comment_id: COMMENT_ID },
        message: {
          text: OPENING,
          quick_replies: [
            { content_type: "text", title: "Yes, send it", payload: ACTION_PAYLOAD },
          ],
        },
      },
      { commentId: COMMENT_ID, mode: "private_quick_reply", messageLength: OPENING.length },
    );
  });
});

describe("sendGuideFollowerGate", () => {
  it("uses a generic gate only when the capability is proven, with the fixed profile URL and opaque check-follow payload", async () => {
    await sendGuideFollowerGate({
      recipientId: RECIPIENT_ID,
      guideName: "toddler sleep guide",
      coverUrl: COVER_URL,
      actionToken: ACTION_TOKEN,
      capabilities: { privateQuickReply: false, dmGenericGate: true },
    });

    expect(GUIDE_PROFILE_URL).toBe("https://www.instagram.com/tinysoho/");
    expect(sendMetaMessage).toHaveBeenCalledOnce();
    expect(sendMetaMessage).toHaveBeenCalledWith(
      {
        recipient: { id: RECIPIENT_ID },
        messaging_type: "RESPONSE",
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: [
                {
                  title: "Your toddler sleep guide is waiting ✨",
                  subtitle:
                    "Follow @tinysoho for more ideas like this, then tap I'm following and I'll send it over.",
                  image_url: COVER_URL,
                  default_action: { type: "web_url", url: GUIDE_PROFILE_URL },
                  buttons: [
                    { type: "web_url", url: GUIDE_PROFILE_URL, title: "Visit profile" },
                    {
                      type: "postback",
                      title: "I'm following ✓",
                      payload: ACTION_PAYLOAD,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      { recipientId: RECIPIENT_ID, mode: "dm_generic_gate", messageLength: 0 },
    );
  });

  it("uses plain text with the profile URL when generic capability is unproven", async () => {
    await sendGuideFollowerGate({
      recipientId: RECIPIENT_ID,
      guideName: "toddler sleep guide",
      coverUrl: COVER_URL,
      actionToken: ACTION_TOKEN,
    });

    const text =
      "Your toddler sleep guide is waiting ✨\n\n" +
      "Follow @tinysoho for more ideas like this, then reply YES and I'll send it over.\n\n" +
      "Visit profile: https://www.instagram.com/tinysoho/";
    expect(sendMetaMessage).toHaveBeenCalledOnce();
    expect(sendMetaMessage).toHaveBeenCalledWith(
      { recipient: { id: RECIPIENT_ID }, messaging_type: "RESPONSE", message: { text } },
      { recipientId: RECIPIENT_ID, mode: "dm_text_gate", messageLength: text.length },
    );
  });
});

describe("sendGuideFollowLag", () => {
  it("keeps the replacement token at the sender boundary while capability is text-only", async () => {
    const text =
      "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then reply YES once more.";

    await sendGuideFollowLag({
      recipientId: RECIPIENT_ID,
      actionToken: ACTION_TOKEN,
    });

    expect(sendMetaMessage).toHaveBeenCalledWith(
      {
        recipient: { id: RECIPIENT_ID },
        messaging_type: "RESPONSE",
        message: { text },
      },
      { recipientId: RECIPIENT_ID, mode: "dm_text_follow_lag", messageLength: text.length },
    );
  });

  it("exposes only the replacement opaque token when DM quick replies are proven", async () => {
    await sendGuideFollowLag({
      recipientId: RECIPIENT_ID,
      actionToken: ACTION_TOKEN,
      capabilities: {
        privateQuickReply: false,
        dmGenericGate: false,
        dmQuickReply: true,
      },
    });

    expect(sendMetaMessage).toHaveBeenCalledWith(
      {
        recipient: { id: RECIPIENT_ID },
        messaging_type: "RESPONSE",
        message: {
          text:
            "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
          quick_replies: [
            {
              content_type: "text",
              title: "I'm following ✓",
              payload: ACTION_PAYLOAD,
            },
          ],
        },
      },
      {
        recipientId: RECIPIENT_ID,
        mode: "dm_quick_reply_follow_lag",
        messageLength:
          "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.".length,
      },
    );
  });
});

// Fix round 3. Text mode is the ONLY mode available while every capability row is
// `not_verified`, yet all three text branches told the parent to "tap" a control
// that does not exist there, and the opening never asked for the short `YES` the
// spec's fallback requires ("send the same copy as text. The fallback asks for a
// short YES ... DONE is not required"). Rich copy is unchanged.
describe("text-mode copy references no controls", () => {
  const REPLY_ASK = /reply YES/i;

  async function sentText(): Promise<string> {
    const [payload] = sendMetaMessage.mock.calls[0]!;
    return (payload as { message: { text: string } }).message.text;
  }

  it("the text opening asks for a short YES and mentions no tap", async () => {
    await sendGuideInitialPrivateReply({
      commentId: COMMENT_ID,
      guideName: "toddler sleep guide",
      actionToken: ACTION_TOKEN,
    });

    const text = await sentText();
    expect(text).toMatch(REPLY_ASK);
    expect(text).not.toMatch(/\btap\b/i);
    // Still the same opening copy, per the spec's "send the same copy as text".
    expect(text).toContain("I've got the toddler sleep guide you asked for");
  });

  it("the text follower gate asks for a reply and mentions no tap", async () => {
    await sendGuideFollowerGate({
      recipientId: RECIPIENT_ID,
      guideName: "toddler sleep guide",
      coverUrl: COVER_URL,
      actionToken: ACTION_TOKEN,
    });

    const text = await sentText();
    expect(text).toMatch(REPLY_ASK);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).toContain("Follow @tinysoho");
    expect(text).toContain(GUIDE_PROFILE_URL);
  });

  it("the text follow-lag response asks for a reply and mentions no tap", async () => {
    await sendGuideFollowLag({
      recipientId: RECIPIENT_ID,
      actionToken: ACTION_TOKEN,
    });

    const text = await sentText();
    expect(text).toMatch(REPLY_ASK);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).toContain("Instagram may take a moment to update");
  });

  it("keeps the button wording when the rich control is actually proven", async () => {
    await sendGuideInitialPrivateReply({
      commentId: COMMENT_ID,
      guideName: "toddler sleep guide",
      actionToken: ACTION_TOKEN,
      capabilities: { privateQuickReply: true, dmGenericGate: false },
    });

    const text = await sentText();
    expect(text).not.toMatch(REPLY_ASK);
    expect(text).toBe(OPENING);
  });
});
