import { describe, expect, it } from "vitest";
import { dmDraftRequestSchema } from "./schemas.js";

const VALID_REQUEST = {
  requestId: "11111111-1111-1111-1111-111111111111",
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "inbound",
      text: "Could you share a nap routine?",
      messageType: "text",
      source: "instagram_user",
      at: "2026-08-04T10:00:00.000Z",
    },
  ],
  brandVoice: "Warm, practical, concise.",
  guideContext: null,
};

describe("dmDraftRequestSchema", () => {
  it("accepts a version 2 reply request without a delivered guide", () => {
    expect(
      dmDraftRequestSchema.parse({
        ...VALID_REQUEST,
        kind: "reply",
        promptVersion: 2,
        guideDeliveredAt: null,
      }),
    ).toMatchObject({ kind: "reply", promptVersion: 2, guideDeliveredAt: null });
  });

  it("rejects a follow-up request using an unversioned prompt", () => {
    expect(() =>
      dmDraftRequestSchema.parse({
        ...VALID_REQUEST,
        kind: "engagement_follow_up",
        promptVersion: 1,
        guideDeliveredAt: "2026-08-04T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects unknown request fields at the runtime boundary", () => {
    expect(() =>
      dmDraftRequestSchema.parse({
        ...VALID_REQUEST,
        kind: "reply",
        promptVersion: 2,
        guideDeliveredAt: null,
        unexpected: "not accepted",
      }),
    ).toThrow();
  });
});
