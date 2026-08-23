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

// Parent-delivery Task 3. The published cover becomes one more unit in the SAME durable
// plan, so it inherits the existing claim lease, checkpoints, retry policy and
// uncertain-send review rather than getting a sender of its own.
describe("generated cover unit", () => {
  const COVER_VERSION = "70000000-0000-4000-8000-000000000007";
  const COVER_URL = "https://cdn.example.test/guide-cover/sleep/dm.png";

  it("prepends exactly one image unit at position 0", () => {
    const units = compiled({
      messages: [textStep({ id: "m1", order: 0, body: "Step one" })],
      triggerKind: "inbound_reply",
      cover: { versionId: COVER_VERSION, mediaUrl: COVER_URL },
    });

    expect(units[0]).toMatchObject({
      position: 0,
      origin: "generated_cover",
      kind: "image",
      resourceMessageId: null,
      textSnapshot: null,
      mediaUrlSnapshot: COVER_URL,
    });
    expect(units.filter((unit) => unit.origin === "generated_cover")).toHaveLength(1);
    // The authored steps follow unmodified, just shifted.
    expect(units[1]).toMatchObject({ position: 1, origin: "resource_step", kind: "text" });
  });

  it("adds nothing when no cover is supplied", () => {
    const units = compiled({
      messages: [textStep({ id: "m1", order: 0, body: "Step one" })],
      triggerKind: "inbound_reply",
    });

    expect(units.some((unit) => unit.origin === "generated_cover")).toBe(false);
    expect(units[0]).toMatchObject({ position: 0, origin: "resource_step" });
  });

  it("omits the cover when the parent already saw it in the gate", () => {
    const units = compiled({
      messages: [textStep({ id: "m1", order: 0, body: "Step one" })],
      triggerKind: "inbound_reply",
      cover: { versionId: COVER_VERSION, mediaUrl: COVER_URL },
      coverAlreadyShown: true,
    });

    // A non-follower who accepted the cover during the gate must not receive it twice.
    expect(units.some((unit) => unit.origin === "generated_cover")).toBe(false);
  });

  it("places the cover after a redelivery intro but before the guide", () => {
    const units = compiled({
      messages: [textStep({ id: "m1", order: 0, body: "Step one" })],
      triggerKind: "explicit_redelivery",
      redeliveryIntro: "Here it is again",
      cover: { versionId: COVER_VERSION, mediaUrl: COVER_URL },
    });

    // The spec's "prepends" means ahead of the resource steps, which this satisfies.
    // Context first: a redelivery that opens with a bare image gives the parent a picture
    // before any explanation of why it arrived again.
    expect(units.map((unit) => [unit.position, unit.origin])).toEqual([
      [0, "redelivery_intro"],
      [1, "generated_cover"],
      [2, "resource_step"],
    ]);
  });

  // Only the empty-string case is kept. A `null as unknown as string` variant exercised
  // the cast, not a state the type system permits, so it proved less than it appeared to.
  it.each([{ mediaUrl: "" }])(
    "refuses the whole plan when the cover URL is unusable (%o)",
    ({ mediaUrl }) => {
      const result = compileGuideDeliveryPlan({
        messages: [textStep({ id: "m1", order: 0, body: "Step one" })],
        triggerKind: "inbound_reply",
        cover: { versionId: COVER_VERSION, mediaUrl },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a preflight failure");
      expect(result.error).toMatchObject({
        code: "media_url_missing",
        resourceMessageId: null,
        unitKind: "image",
      });
    },
  );

  it("fingerprints a cover differently from an authored image with the same URL", () => {
    const [cover] = compiled({
      messages: [],
      triggerKind: "inbound_reply",
      cover: { versionId: COVER_VERSION, mediaUrl: COVER_URL },
    });
    const [authored] = compiled({
      messages: [imageStep({ id: "m1", order: 0, body: null, mediaUrl: COVER_URL })],
      triggerKind: "inbound_reply",
    });

    // Without origin in the hash these collide, and two structurally different units
    // would claim identical content.
    expect(cover!.contentFingerprint).not.toBe(authored!.contentFingerprint);
  });

  it("fingerprints two cover versions differently even at the same URL", () => {
    const [first] = compiled({
      messages: [],
      triggerKind: "inbound_reply",
      cover: { versionId: COVER_VERSION, mediaUrl: COVER_URL },
    });
    const [second] = compiled({
      messages: [],
      triggerKind: "inbound_reply",
      cover: { versionId: "80000000-0000-4000-8000-000000000008", mediaUrl: COVER_URL },
    });

    expect(first!.contentFingerprint).not.toBe(second!.contentFingerprint);
  });

  // Deliberately no "same input hashes the same" test: `contentFingerprint` is a pure
  // SHA-256 over the same fields, so such a test cannot fail without the hash itself
  // being non-deterministic. It would report coverage it does not provide.
});
