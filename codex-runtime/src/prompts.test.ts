import { describe, expect, it } from "vitest";
import type { DmDraftRequest } from "./schemas.js";
import { renderBrandContext, renderTranscript } from "./prompts.js";

const REQUEST: DmDraftRequest = {
  requestId: "11111111-1111-1111-1111-111111111111",
  kind: "reply",
  promptVersion: 2,
  guideDeliveredAt: null,
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "outbound",
      text: "Older message",
      messageType: "text",
      source: "manual_external",
      at: "2026-08-05T09:00:00.000Z",
    },
    {
      direction: "inbound",
      text: "Newest message",
      messageType: "text",
      source: "instagram_user",
      at: "2026-08-05T10:00:00.000Z",
    },
  ],
  brandVoice: "Warm and practical.",
  guideContext: null,
};

describe("DM prompt context", () => {
  it("renders the bounded transcript in the backend-provided order", () => {
    expect(renderTranscript(REQUEST)).toBe(
      "Conversation with Geri.\n\nUS: Older message\nTHEM: Newest message",
    );
  });

  it("renders only the exact guide supplied for a delivered-guide follow-up", () => {
    const rendered = renderBrandContext({
      ...REQUEST,
      kind: "engagement_follow_up",
      guideDeliveredAt: "2026-08-05T10:00:00.000Z",
      guideContext: {
        keyword: "SLEEP",
        resourceName: "Sleep Guide",
        description: "A practical bedtime guide",
      },
    });

    expect(rendered).toBe(
      [
        "Brand voice: Warm and practical.",
        "",
        "A guide was already delivered in this conversation (naturally reference it or its topic; do not offer it as new):",
        "- keyword: SLEEP",
        "- name: Sleep Guide",
        "- about: A practical bedtime guide",
      ].join("\n"),
    );
  });
});
