// src/meta/linkGuidePayloads.test.ts
import { describe, expect, it } from "vitest";
import {
  buildLinkGuideCardPayload,
  buildLinkGuideTextPayload,
  LINK_GUIDE_FOLLOW_BUTTON_LABEL,
} from "./linkGuidePayloads.js";

const CARD = {
  title: "Your Halloween recipes 👻",
  subtitle: "8 toddler-friendly recipes, ready to cook",
  coverUrl: "https://cdn.example.com/cover.png",
  buttonLabel: "Open the recipes",
  trackedUrl: "https://api.example.com/r/tok_ABCDEFG",
  profileUrl: "https://www.instagram.com/tinysoho/",
};

describe("buildLinkGuideCardPayload", () => {
  it("builds the private-reply card with the link first and the follow button second", () => {
    expect(buildLinkGuideCardPayload({ ...CARD, recipient: { comment_id: "comment-1" } })).toEqual({
      recipient: { comment_id: "comment-1" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                title: CARD.title,
                subtitle: CARD.subtitle,
                image_url: CARD.coverUrl,
                default_action: { type: "web_url", url: CARD.trackedUrl },
                buttons: [
                  { type: "web_url", url: CARD.trackedUrl, title: "Open the recipes" },
                  { type: "web_url", url: CARD.profileUrl, title: LINK_GUIDE_FOLLOW_BUTTON_LABEL },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("marks an open-thread DM as a response", () => {
    const payload = buildLinkGuideCardPayload({ ...CARD, recipient: { id: "ig-parent" } });
    expect(payload.recipient).toEqual({ id: "ig-parent" });
    expect(payload.messaging_type).toBe("RESPONSE");
  });

  it.each([
    { trackedUrl: "http://api.example.com/r/tok_ABCDEFG" },
    { coverUrl: "not a url" },
    { buttonLabel: "This label is far too long" },
    { title: "" },
    { subtitle: "x".repeat(81) },
  ])("refuses %o", (patch) => {
    expect(() =>
      buildLinkGuideCardPayload({ ...CARD, ...patch, recipient: { comment_id: "comment-1" } }),
    ).toThrow("invalid_link_guide_payload");
  });
});

describe("buildLinkGuideTextPayload", () => {
  it("sends plain text in the private-reply slot", () => {
    const text = "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG";
    expect(buildLinkGuideTextPayload({ recipient: { comment_id: "comment-1" }, text })).toEqual({
      recipient: { comment_id: "comment-1" },
      message: { text },
    });
  });

  it("refuses empty text", () => {
    expect(() => buildLinkGuideTextPayload({ recipient: { id: "ig-parent" }, text: "  " })).toThrow(
      "invalid_link_guide_payload",
    );
  });
});
