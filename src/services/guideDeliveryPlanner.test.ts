import { describe, expect, it } from "vitest";
import {
  compileGuideDeliveryPlan,
  type AuthoredGuideMessage,
} from "./guideDeliveryPlanner.js";

const textStep = (input: Omit<AuthoredGuideMessage, "type" | "mediaUrl">): AuthoredGuideMessage => ({
  ...input,
  type: "text",
  mediaUrl: null,
});

const imageStep = (input: Omit<AuthoredGuideMessage, "type">): AuthoredGuideMessage => ({
  ...input,
  type: "image",
});

const pdfStep = (input: Omit<AuthoredGuideMessage, "type">): AuthoredGuideMessage => ({
  ...input,
  type: "pdf",
});

function compiled(input: Parameters<typeof compileGuideDeliveryPlan>[0]) {
  const result = compileGuideDeliveryPlan(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected a valid plan, received ${result.error.code}`);
  return result.units;
}

describe("compileGuideDeliveryPlan", () => {
  it("sorts authored steps and expands each actual Meta send unit in order", () => {
    const units = compiled({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [
        textStep({ id: "text-1", order: 2, body: "Third" }),
        imageStep({
          id: "image-1",
          order: 0,
          mediaUrl: "https://cdn/image.jpg",
          body: "Caption",
        }),
        pdfStep({ id: "pdf-1", order: 1, mediaUrl: "https://cdn/file.pdf", body: null }),
      ],
    });

    expect(units).toMatchObject([
      { position: 0, kind: "image", resourceMessageId: "image-1", origin: "resource_step" },
      { position: 1, kind: "text", resourceMessageId: "image-1", origin: "resource_step" },
      { position: 2, kind: "file", resourceMessageId: "pdf-1", origin: "resource_step" },
      { position: 3, kind: "text", resourceMessageId: "text-1", origin: "resource_step" },
    ]);
    expect(units[0]).toMatchObject({ mediaUrlSnapshot: "https://cdn/image.jpg", textSnapshot: null });
    expect(units[1]).toMatchObject({ textSnapshot: "Caption", mediaUrlSnapshot: null });
  });

  it("makes the explicit redelivery introduction a durable first unit", () => {
    const units = compiled({
      triggerKind: "explicit_redelivery",
      redeliveryIntro: "You've already got this one — here it is again 💛",
      messages: [textStep({ id: "text-1", order: 0, body: "Guide" })],
    });

    expect(units).toMatchObject([
      {
        position: 0,
        origin: "redelivery_intro",
        kind: "text",
        resourceMessageId: null,
        textSnapshot: "You've already got this one — here it is again 💛",
      },
      { position: 1, origin: "resource_step", kind: "text", resourceMessageId: "text-1" },
    ]);
  });

  it("rejects a later over-limit caption after compiling the full plan", () => {
    const privateCaption = `PRIVATE-CAPTION-${"💛".repeat(985)}`;
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [
        textStep({ id: "first", order: 0, body: "Valid first unit" }),
        imageStep({ id: "later-image", order: 1, mediaUrl: "https://cdn/good.jpg", body: privateCaption }),
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "text_too_long",
        resourceMessageId: "later-image",
        authoredOrder: 1,
        unitKind: "text",
        actualLength: 1_001,
        limit: 1_000,
      },
    });
  });

  it.each([
    ["image", imageStep({ id: "image-1", order: 4, mediaUrl: null, body: null }), "image"],
    ["PDF", pdfStep({ id: "pdf-1", order: 5, mediaUrl: "", body: null }), "file"],
  ] as const)("rejects an authored %s step with no usable URL", (_label, message, unitKind) => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [message],
    });

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
  });

  it.each([null, ""] as const)("rejects a Text step without its required body", (body) => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [textStep({ id: "text-1", order: 3, body })],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "text_missing",
        resourceMessageId: "text-1",
        authoredOrder: 3,
        unitKind: "text",
        actualLength: 0,
        limit: 1_000,
      },
    });
  });

  it("accepts exactly 1,000 Unicode code points", () => {
    const units = compiled({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [textStep({ id: "text-1", order: 0, body: "💛".repeat(1_000) })],
    });

    expect(units).toHaveLength(1);
    expect([...((units[0]?.textSnapshot) ?? "")]).toHaveLength(1_000);
  });

  it("keeps a nonempty whitespace caption as an authored text unit", () => {
    const units = compiled({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [imageStep({ id: "image-1", order: 0, mediaUrl: "https://cdn/image.jpg", body: "   " })],
    });

    expect(units).toHaveLength(2);
    expect(units[1]).toMatchObject({ kind: "text", textSnapshot: "   " });
  });

  it("rejects an explicit redelivery that lacks its durable introduction", () => {
    const result = compileGuideDeliveryPlan({
      triggerKind: "explicit_redelivery",
      messages: [textStep({ id: "text-1", order: 0, body: "Guide" })],
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

  it("produces stable content fingerprints that change with unit kind or exact payload", () => {
    const fingerprint = (message: AuthoredGuideMessage) =>
      compiled({ triggerKind: "inbound_reply", redeliveryIntro: "unused", messages: [message] })[0]
        ?.contentFingerprint;

    expect(fingerprint(textStep({ id: "one", order: 0, body: "Exact payload" }))).toBe(
      fingerprint(textStep({ id: "two", order: 4, body: "Exact payload" })),
    );
    expect(fingerprint(textStep({ id: "one", order: 0, body: "Exact payload" }))).not.toBe(
      fingerprint(textStep({ id: "one", order: 0, body: "Exact payload " })),
    );
    expect(fingerprint(imageStep({ id: "one", order: 0, mediaUrl: "Exact payload", body: null }))).not.toBe(
      fingerprint(textStep({ id: "one", order: 0, body: "Exact payload" })),
    );
  });

  it("keeps submitted text and media URLs out of preflight error metadata", () => {
    const privateText = "PRIVATE-TEXT-SENTINEL".repeat(70);
    const privateUrl = "https://private.example/PRIVATE-URL-SENTINEL";
    const result = compileGuideDeliveryPlan({
      triggerKind: "inbound_reply",
      redeliveryIntro: "unused",
      messages: [
        textStep({ id: "safe-id", order: 8, body: privateText }),
        imageStep({ id: "later", order: 9, mediaUrl: privateUrl, body: null }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      resourceMessageId: "safe-id",
      authoredOrder: 8,
      unitKind: "text",
      actualLength: 1_470,
    });
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain("PRIVATE-TEXT-SENTINEL");
    expect(serialized).not.toContain("PRIVATE-URL-SENTINEL");
  });
});
