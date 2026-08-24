import { describe, expect, it } from "vitest";
import {
  GUIDE_GATE_BUTTON_LABELS,
  GUIDE_GATE_CATEGORY_ACTION_LABELS,
  buildGuideGateCapabilityPayload,
  guideGateCardActionLabel,
} from "./guideGatePayloads.js";
import { GUIDE_COVER_CATEGORIES } from "../../shared/guideCoverRegistry.js";

const COMMENT_ID = "17890000000000001";
const RECIPIENT_ID = "17890000000000002";
const ACTION_TOKEN = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
const ACTION_PAYLOAD = `ts:guide:${ACTION_TOKEN}`;
const PROFILE_URL = "https://www.instagram.com/tinysoho/";
const COVER_URL = "https://cdn.example.com/guide-cover/sleep/dm.png";
const GUIDE_NAME = "toddler sleep guide";
const OPENING =
  "Got it 💛 I've got it ready for you. Want me to send it here?";
// The text-only case carries no control, so it asks for the short reply instead.
const OPENING_TEXT = `${OPENING} Reply YES and I'll send it over.`;

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
      message: { text: OPENING_TEXT },
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
        title: "Your guide is ready ✨",
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
                title: "Your guide is ready ✨",
                subtitle: "Tap below and I'll check access before sending it here.",
                image_url: COVER_URL,
                default_action: { type: "web_url", url: PROFILE_URL },
                buttons: [
                  {
                    type: "postback",
                    title: "Send it over",
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

  it("builds a follow-lag quick reply with the replacement opaque token", () => {
    expect(
      buildGuideGateCapabilityPayload({
        case: "dm_follow_lag",
        recipientId: RECIPIENT_ID,
        actionToken: ACTION_TOKEN,
      }),
    ).toEqual({
      recipient: { id: RECIPIENT_ID },
      messaging_type: "RESPONSE",
      message: {
        text:
          "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
        quick_replies: [
          {
            content_type: "text",
            title: "I'm following",
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
        title: "Your guide is waiting ✨",
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
                title: "Your guide is waiting ✨",
                subtitle:
                  "Follow @tinysoho for more ideas like this, then tap below and I'll send it over.",
                image_url: COVER_URL,
                default_action: { type: "web_url", url: PROFILE_URL },
                buttons: [
                  { type: "web_url", url: PROFILE_URL, title: "Visit profile" },
                  {
                    type: "postback",
                    title: "Send it over",
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
        title: "Your guide is waiting ✨",
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
      // The opening no longer renders the name at all, so a hostile name cannot reach a
      // parent's screen. It is still VALIDATED on input, which is what this case now proves.
      text: OPENING,
      quick_replies: [
        { content_type: "text", title: "Yes, send it", payload: ACTION_PAYLOAD },
      ],
    });
  });

  it("never copies query parameters from a validated cover URL into object keys", () => {
    const coverUrl = "https://cdn.example.com/cover.png?title=buttons&payload=forged";
    const payload = buildGuideGateCapabilityPayload({
      case: "private_generic",
      title: "Your guide is ready ✨",
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

describe("per-category card action label", () => {
  function cardButtons(categorySlug?: string) {
    const payload = buildGuideGateCapabilityPayload({
      case: "dm_generic_gate",
      title: "Your guide is waiting ✨",
      recipientId: RECIPIENT_ID,
      guideName: GUIDE_NAME,
      profileUrl: PROFILE_URL,
      coverUrl: COVER_URL,
      actionToken: ACTION_TOKEN,
      ...(categorySlug ? { categorySlug } : {}),
    });
    const message = payload.message;
    if (!("attachment" in message)) throw new Error("expected a template message");
    return message.attachment.payload.elements[0]!.buttons;
  }

  it("names what it is sending, per category", () => {
    expect(cardButtons("bedtime")[1]).toMatchObject({
      type: "postback",
      title: "Send my tiny win",
    });
    expect(cardButtons("recipes")[1]).toMatchObject({ title: "Send the recipes" });
    expect(cardButtons("montessori-activities")[1]).toMatchObject({
      title: "Send the activity",
    });
    expect(cardButtons("potty-training")[1]).toMatchObject({ title: "Send the steps" });
  });

  /**
   * Absent or unrecognised categories degrade to the generic label. Rejecting the payload
   * instead would let a copy lookup cost a parent their guide, which is the wrong trade for
   * a button's wording.
   */
  it("falls back rather than failing when the category is missing or unknown", () => {
    expect(cardButtons()[1]).toMatchObject({ title: "Send it over" });
    expect(cardButtons("not-a-category")[1]).toMatchObject({ title: "Send it over" });
    expect(guideGateCardActionLabel(undefined)).toBe("Send it over");
    expect(guideGateCardActionLabel("")).toBe("Send it over");
  });

  /**
   * Every registered cover category needs a label, because every one of them can render a
   * card. Derived from the registry rather than listed here, so adding a category fails this
   * test instead of silently shipping "Send it over" on a cover that names something else.
   */
  it("covers every registered cover category", () => {
    for (const slug of Object.keys(GUIDE_COVER_CATEGORIES)) {
      expect(
        GUIDE_GATE_CATEGORY_ACTION_LABELS[slug as keyof typeof GUIDE_GATE_CATEGORY_ACTION_LABELS],
        `no card action label for ${slug}`,
      ).toBeTruthy();
    }
  });

  /**
   * Meta documents two things about button titles: keep them under 20 characters, and prefer
   * one to three words.
   *
   * Only the length is asserted. Length is what actually breaks — a long title is truncated
   * on device, and the truncation is invisible from any payload assertion, so nothing else
   * would catch it. Word count is a style preference, and encoding taste as a hard rule is
   * how a test starts rejecting better copy: this assertion originally failed "Send my tiny
   * win" for being four words, which is the label that ties the card to its own kicker and
   * the reason this feature exists.
   */
  it("keeps every button label inside Meta's 20-character guidance", () => {
    const labels = [
      ...Object.values(GUIDE_GATE_BUTTON_LABELS),
      ...Object.values(GUIDE_GATE_CATEGORY_ACTION_LABELS),
    ];
    for (const label of labels) {
      expect([...label].length, `"${label}" is too long for a button`).toBeLessThanOrEqual(20);
    }
  });

  /**
   * The chip labels are a different job and must stay parent-voiced: a quick reply's title is
   * posted into the thread AS THE PARENT'S OWN MESSAGE. The "✓" that used to be here showed up
   * inside their sent message, reading as a UI artifact in their words.
   */
  it("keeps quick-reply labels free of interface decoration", () => {
    for (const label of [
      GUIDE_GATE_BUTTON_LABELS.requestGuide,
      GUIDE_GATE_BUTTON_LABELS.confirmFollow,
    ]) {
      expect(label, `"${label}" reads as UI, not as something a parent would type`).not.toMatch(
        /[✓✔☑»▸]/u,
      );
    }
  });
});

/**
 * The follow re-ask card, for a parent who tapped a follow control without following.
 *
 * A separate case from `dm_generic_gate` because the second button is a different question. The
 * gate asks them to follow, so its button sends the guide ("Send the recipes"); by the re-ask
 * they have already been asked, so the button confirms ("I'm following").
 */
describe("dm_follow_reask_card", () => {
  const valid = {
    case: "dm_follow_reask_card" as const,
    recipientId: RECIPIENT_ID,
    title: "One step left 💛",
    subtitle: "Follow @tinysoho for more recipes like this, then tap I'm following.",
    profileUrl: PROFILE_URL,
    coverUrl: COVER_URL,
    actionToken: ACTION_TOKEN,
  };

  it("carries a profile link and a confirm postback, in that order", () => {
    const payload = buildGuideGateCapabilityPayload(valid);
    const element = (
      payload.message as {
        attachment: { payload: { elements: [Record<string, unknown>] } };
      }
    ).attachment.payload.elements[0];

    expect(element.title).toBe("One step left 💛");
    expect(element.subtitle).toBe(valid.subtitle);
    expect(element.image_url).toBe(COVER_URL);
    // Profile first: following is the thing they have to do, and the confirm is only useful
    // afterwards.
    expect(element.buttons).toEqual([
      { type: "web_url", url: PROFILE_URL, title: "Visit profile" },
      { type: "postback", title: "I'm following", payload: ACTION_PAYLOAD },
    ]);
  });

  /**
   * Meta truncates a subtitle past 80 characters silently and on device. The payload keeps its
   * own guard rather than trusting the copy layer, because the copy layer is where an 81-character
   * string already slipped through once.
   */
  it("rejects a subtitle Meta would silently truncate", () => {
    expect(() =>
      buildGuideGateCapabilityPayload({ ...valid, subtitle: "x".repeat(81) }),
    ).toThrow("invalid_guide_gate_payload");
    expect(() => buildGuideGateCapabilityPayload({ ...valid, subtitle: "   " })).toThrow(
      "invalid_guide_gate_payload",
    );
  });

  it("refuses a non-https cover or profile URL, and a non-uuid token", () => {
    for (const bad of [
      { coverUrl: "http://cdn.example.com/square.png" },
      { profileUrl: "http://www.instagram.com/tinysoho/" },
      { actionToken: "not-a-uuid" },
    ]) {
      expect(() => buildGuideGateCapabilityPayload({ ...valid, ...bad })).toThrow(
        "invalid_guide_gate_payload",
      );
    }
  });
});
