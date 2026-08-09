import { describe, expect, it } from "vitest";
import { compileGuideDeliveryPlan } from "./guideDeliveryPlanner.js";

type StepOverrides = {
  id?: string;
  order?: number;
  body?: string | null;
  mediaUrl?: string | null;
};

function textStep(overrides: StepOverrides = {}) {
  return {
    id: "text-step",
    order: 0,
    type: "text" as const,
    body: "Text body",
    mediaUrl: null,
    ...overrides,
  };
}

function imageStep(overrides: StepOverrides = {}) {
  return {
    id: "image-step",
    order: 0,
    type: "image" as const,
    body: null,
    mediaUrl: "https://cdn/image.jpg",
    ...overrides,
  };
}

function pdfStep(overrides: StepOverrides = {}) {
  return {
    id: "pdf-step",
    order: 0,
    type: "pdf" as const,
    body: null,
    mediaUrl: "https://cdn/file.pdf",
    ...overrides,
  };
}

describe("compileGuideDeliveryPlan", () => {
  it("sorts authored steps without mutating them and expands media captions in exact send order", () => {
    const messages = [
      textStep({ id: "text-1", order: 2, body: "Third" }),
      imageStep({
        id: "image-1",
        order: 0,
        mediaUrl: "https://cdn/image.jpg",
        body: "Caption",
      }),
      pdfStep({ id: "pdf-1", order: 1, mediaUrl: "https://cdn/file.pdf", body: null }),
    ];

    const result = compileGuideDeliveryPlan({ triggerKind: "inbound_reply", messages });

    expect(messages.map((message) => message.id)).toEqual(["text-1", "image-1", "pdf-1"]);
    expect(result).toEqual({
      ok: true,
      units: [
        {
          position: 0,
          origin: "resource_step",
          kind: "image",
          resourceMessageId: "image-1",
          textSnapshot: null,
          mediaUrlSnapshot: "https://cdn/image.jpg",
          contentFingerprint: "14d61fed12b02ddd548e885e5b31d82b52d27fd6bf0865bc398f230c0e2a13af",
        },
        {
          position: 1,
          origin: "resource_step",
          kind: "text",
          resourceMessageId: "image-1",
          textSnapshot: "Caption",
          mediaUrlSnapshot: null,
          contentFingerprint: "6cfc5ef5d35b03fe9391669e66c4e20a62f28f8690e7fd690a0a9916ee153432",
        },
        {
          position: 2,
          origin: "resource_step",
          kind: "file",
          resourceMessageId: "pdf-1",
          textSnapshot: null,
          mediaUrlSnapshot: "https://cdn/file.pdf",
          contentFingerprint: "7654dea9b4533389762806ace687367f2bf7d30407f061770f59df9fd44e5b0f",
        },
        {
          position: 3,
          origin: "resource_step",
          kind: "text",
          resourceMessageId: "text-1",
          textSnapshot: "Third",
          mediaUrlSnapshot: null,
          contentFingerprint: "a418ad88e3ba7069fdfe27c35d596bc056735b13cf92d11cdfd7328a96dbe932",
        },
      ],
    });
  });

  it("prepends the exact caller-authored intro only for explicit redelivery", () => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "explicit_redelivery",
      redeliveryIntro: "Exact intro 💛",
      messages: [textStep({ id: "guide-text", body: "Guide body" })],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units[0]).toEqual({
      position: 0,
      origin: "redelivery_intro",
      kind: "text",
      resourceMessageId: null,
      textSnapshot: "Exact intro 💛",
      mediaUrlSnapshot: null,
      contentFingerprint: "5387625d8be0bd7ceeeb681ca838e258aa687b5e78e85afc1b7ab128ff66e3c3",
    });
    expect(result.units[1]).toMatchObject({
      position: 1,
      origin: "resource_step",
      resourceMessageId: "guide-text",
    });
  });

  it("rejects the whole plan when a later caption exceeds 1,000 UTF-16 code units", () => {
    const privateCaption = `${"a".repeat(999)}😀`;
    const privateUrl = "https://cdn/private-later-image.jpg";

    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [
        textStep({ id: "valid-first", order: 0, body: "Valid first" }),
        imageStep({
          id: "invalid-later",
          order: 1,
          body: privateCaption,
          mediaUrl: privateUrl,
        }),
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "text_too_long",
        resourceMessageId: "invalid-later",
        authoredOrder: 1,
        unitKind: "text",
        actualLength: 1_001,
        limit: 1_000,
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateCaption);
    expect(JSON.stringify(result)).not.toContain(privateUrl);
  });

  it.each([
    ["image", imageStep({ id: "missing-image", order: 3, mediaUrl: null }), "image"],
    ["pdf", pdfStep({ id: "missing-pdf", order: 4, mediaUrl: "" }), "file"],
  ] as const)("rejects a %s step with no media URL without leaking payloads", (_label, message, unitKind) => {
    const result = compileGuideDeliveryPlan({ triggerKind: "follow_recovery", messages: [message] });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "media_url_missing",
        resourceMessageId: message.id,
        authoredOrder: message.order,
        unitKind,
        actualLength: null,
        limit: null,
      },
    });
    expect(result).not.toHaveProperty("error.mediaUrlSnapshot");
  });

  it.each([null, ""])("rejects a required Text body when it is %s", (body) => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [textStep({ id: "missing-text", order: 7, body })],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "text_missing",
        resourceMessageId: "missing-text",
        authoredOrder: 7,
        unitKind: "text",
        actualLength: 0,
        limit: 1_000,
      },
    });
  });

  it("accepts exactly 1,000 UTF-16 code units", () => {
    const body = "😀".repeat(500);
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [textStep({ body })],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units[0]?.textSnapshot).toBe(body);
  });

  it("preserves whitespace captions instead of trimming or omitting them", () => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [imageStep({ body: "   " })],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.units).toHaveLength(2);
    expect(result.units[1]?.textSnapshot).toBe("   ");
  });

  it("uses a stable fingerprint of the exact kind, NUL separator, and untrimmed payload", () => {
    const first = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [textStep({ body: "same payload" })],
    });
    const identical = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [textStep({ id: "different-row", body: "same payload" })],
    });
    const changedKind = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [imageStep({ mediaUrl: "same payload" })],
    });
    const changedContent = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      messages: [textStep({ body: "same payload " })],
    });

    expect(first.ok && first.units[0]?.contentFingerprint).toBe(
      "6a2fc34aace4869ab065125852380bf43c21dd1cf87c4fa582022ea47d3f667d",
    );
    expect(identical.ok && identical.units[0]?.contentFingerprint).toBe(
      first.ok && first.units[0]?.contentFingerprint,
    );
    expect(changedKind.ok && changedKind.units[0]?.contentFingerprint).not.toBe(
      first.ok && first.units[0]?.contentFingerprint,
    );
    expect(changedContent.ok && changedContent.units[0]?.contentFingerprint).not.toBe(
      first.ok && first.units[0]?.contentFingerprint,
    );
  });

  it("rejects an explicit redelivery without a caller-provided intro", () => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "explicit_redelivery",
      messages: [textStep()],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "text_missing",
        resourceMessageId: null,
        authoredOrder: null,
        unitKind: "text",
        actualLength: 0,
        limit: 1_000,
      },
    });
  });
});
