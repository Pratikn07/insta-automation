import { describe, expect, it } from "vitest";
import {
  GUIDE_GATE_BUTTON_LABELS,
  buildGuideGateCapabilityPayload,
} from "./guideGatePayloads.js";

const COMMENT_ID = "17890000000000001";
const RECIPIENT_ID = "17890000000000002";
const ACTION_TOKEN = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
const ACTION_PAYLOAD = `ts:guide:${ACTION_TOKEN}`;
const PROFILE_URL = "https://www.instagram.com/tinysoho/";
const COVER_URL = "https://cdn.example.com/guide-cover/sleep/dm.png";
const GUIDE_NAME = "toddler sleep guide";
const OPENING =
  "Got it 💛 I've got the toddler sleep guide you asked for. Want me to send it here?";

describe("guide gate capability payloads", () => {
  it("builds the text-only private reply baseline", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "private_text",
        commentId: COMMENT_ID,
        guideName: GUIDE_NAME,
      }),
    ).toEqual({
      recipient: { comment_id: COMMENT_ID },
      message: { text: OPENING },
    });
  });

  it("builds an experimental private quick reply in the one comment slot", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "private_quick_reply",
        commentId: COMMENT_ID,
        guideName: GUIDE_NAME,
        actionToken: ACTION_TOKEN,
      }),
    ).toEqual({
      recipient: { comment_id: COMMENT_ID },
      message: {
        text: OPENING,
        quick_replies: [
          {
            content_type: "text",
            title: "Yes, send it",
            payload: ACTION_PAYLOAD,
          },
        ],
      },
    });
  });

  it("builds an experimental private generic card with one request action", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "private_generic",
        commentId: COMMENT_ID,
        guideName: GUIDE_NAME,
        profileUrl: PROFILE_URL,
        coverUrl: COVER_URL,
        actionToken: ACTION_TOKEN,
      }),
    ).toEqual({
      recipient: { comment_id: COMMENT_ID },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                title: "Your toddler sleep guide is ready",
                subtitle: "Tap below and I'll check access before sending it here.",
                image_url: COVER_URL,
                default_action: { type: "web_url", url: PROFILE_URL },
                buttons: [
                  {
                    type: "postback",
                    title: "Yes, send it",
                    payload: ACTION_PAYLOAD,
                  },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("builds a post-response direct-message quick reply", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "dm_quick_reply",
        recipientId: RECIPIENT_ID,
        guideName: GUIDE_NAME,
        actionToken: ACTION_TOKEN,
      }),
    ).toEqual({
      recipient: { id: RECIPIENT_ID },
      messaging_type: "RESPONSE",
      message: {
        text: OPENING,
        quick_replies: [
          {
            content_type: "text",
            title: "Yes, send it",
            payload: ACTION_PAYLOAD,
          },
        ],
      },
    });
  });

  it("builds a post-response generic follower gate with profile and recheck actions", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "dm_generic_gate",
        recipientId: RECIPIENT_ID,
        guideName: GUIDE_NAME,
        profileUrl: PROFILE_URL,
        coverUrl: COVER_URL,
        actionToken: ACTION_TOKEN,
      }),
    ).toEqual({
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
                default_action: { type: "web_url", url: PROFILE_URL },
                buttons: [
                  { type: "web_url", url: PROFILE_URL, title: "Visit profile" },
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
    });
  });

  it("keeps every quick-reply and generic-template button within Meta's 20-character limit", () => {
    for (const label of Object.values(GUIDE_GATE_BUTTON_LABELS)) {
      expect([...label].length, label).toBeLessThanOrEqual(20);
    }
  });

  it.each([
    ["profileUrl", "http://www.instagram.com/tinysoho/"],
    ["coverUrl", "http://cdn.example.com/cover.png"],
  ] as const)("rejects a non-HTTPS %s", (field, value) => {
    expect(() =>
      buildGuideGateCapabilityPayload({
        case: "dm_generic_gate",
        recipientId: RECIPIENT_ID,
        guideName: GUIDE_NAME,
        profileUrl: field === "profileUrl" ? value : PROFILE_URL,
        coverUrl: field === "coverUrl" ? value : COVER_URL,
        actionToken: ACTION_TOKEN,
      }),
    ).toThrow("invalid_guide_gate_payload");
  });

  it.each(["not-a-uuid", "3f05a514-1f04-4b14-9df4-7730c7c39af4:send-guide"])(
    "rejects a non-opaque action token: %s",
    (actionToken) => {
      expect(() =>
        buildGuideGateCapabilityPayload({
          case: "dm_quick_reply",
          recipientId: RECIPIENT_ID,
          guideName: GUIDE_NAME,
          actionToken,
        }),
      ).toThrow("invalid_guide_gate_payload");
    },
  );

  it.each(["", "recipient/../messages", "1789?access_token=secret"])(
    "rejects an invalid recipient ID: %s",
    (recipientId) => {
      expect(() =>
        buildGuideGateCapabilityPayload({
          case: "dm_quick_reply",
          recipientId,
          guideName: GUIDE_NAME,
          actionToken: ACTION_TOKEN,
        }),
      ).toThrow("invalid_guide_gate_payload");
    },
  );

  it("keeps hostile guide text as a JSON string rather than template structure", () => {
    const hostileGuideName = 'sleep guide", "buttons": [{"type":"web_url"}]';
    const payload = buildGuideGateCapabilityPayload({
      case: "private_quick_reply",
      commentId: COMMENT_ID,
      guideName: hostileGuideName,
      actionToken: ACTION_TOKEN,
    });

    expect(Object.keys(payload)).toEqual(["recipient", "message"]);
    expect(payload.message).toEqual({
      text: `Got it 💛 I've got the ${hostileGuideName} you asked for. Want me to send it here?`,
      quick_replies: [
        { content_type: "text", title: "Yes, send it", payload: ACTION_PAYLOAD },
      ],
    });
  });

  it("never copies query parameters from a validated cover URL into object keys", () => {
    const coverUrl = "https://cdn.example.com/cover.png?title=buttons&payload=forged";
    const payload = buildGuideGateCapabilityPayload({
      case: "private_generic",
      commentId: COMMENT_ID,
      guideName: GUIDE_NAME,
      profileUrl: PROFILE_URL,
      coverUrl,
      actionToken: ACTION_TOKEN,
    });

    expect(JSON.stringify(payload)).toContain(coverUrl);
    expect(Object.keys(payload)).toEqual(["recipient", "message"]);
  });
});
