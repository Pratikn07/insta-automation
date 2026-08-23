import { describe, expect, it } from "vitest";

import {
  GUIDE_COVER_CANVAS,
  GUIDE_COVER_TEXT_RULES,
  normalizeGuideCoverText,
  validateGuideCoverCategoryText,
  validateGuideCoverDraft,
  validateGuideCoverEdition,
} from "./guideCoverPolicy.js";

const validDraft = {
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription:
    "Blush TinySoho sleep guide cover with a moonlit house illustration.",
};

describe("guide cover policy", () => {
  it("pins the canonical rendition and field rules", () => {
    expect(GUIDE_COVER_CANVAS).toEqual({ width: 1200, height: 916 });
    expect(GUIDE_COVER_TEXT_RULES).toEqual({
      kicker: { maxCodePoints: 32, maxLines: 1 },
      collectionLabel: { maxCodePoints: 16, maxLines: 1 },
      headline: { maxCodePoints: 56, maxLines: 2 },
      supportingLine: { maxCodePoints: 90, maxLines: 2 },
      closingLine: { maxCodePoints: 64, maxLines: 2 },
      alternativeDescription: { maxCodePoints: 240, maxLines: 0 },
    });
  });

  it("normalizes Unicode and collapses all whitespace", () => {
    expect(normalizeGuideCoverText("  Cafe\u0301\n\t  bedtime  ")).toBe(
      "Café bedtime",
    );
  });

  it.each([
    ["headline", 56],
    ["supportingLine", 90],
    ["closingLine", 64],
    ["alternativeDescription", 240],
  ] as const)("accepts %s at its exact code-point limit", (field, limit) => {
    const result = validateGuideCoverDraft({
      ...validDraft,
      [field]: "💛".repeat(limit),
    });

    expect(result.ok).toBe(true);
  });

  it("enforces and normalizes category-owned label limits", () => {
    expect(
      validateGuideCoverCategoryText({
        kicker: "k".repeat(32),
        collectionLabel: "c".repeat(16),
      }),
    ).toEqual({
      ok: true,
      value: {
        kicker: "K".repeat(32),
        collectionLabel: "C".repeat(16),
      },
    });
    expect(
      validateGuideCoverCategoryText({
        kicker: "k".repeat(33),
        collectionLabel: "RECIPES",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "cover_text_overflow",
        field: "kicker",
        reason: "character_limit",
      },
    });
    expect(
      validateGuideCoverCategoryText({
        kicker: "A LITTLE WIN",
        collectionLabel: "c".repeat(17),
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "cover_text_overflow",
        field: "collectionLabel",
        reason: "character_limit",
      },
    });
  });

  it.each([
    ["headline", 56],
    ["supportingLine", 90],
    ["closingLine", 64],
    ["alternativeDescription", 240],
  ] as const)("rejects %s above its exact code-point limit", (field, limit) => {
    const result = validateGuideCoverDraft({
      ...validDraft,
      [field]: "a".repeat(limit + 1),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cover_text_overflow",
        field,
        reason: "character_limit",
      },
    });
  });

  it.each(["headline", "supportingLine", "closingLine", "alternativeDescription"] as const)(
    "requires a non-empty %s",
    (field) => {
      const result = validateGuideCoverDraft({ ...validDraft, [field]: " \n " });

      expect(result).toEqual({
        ok: false,
        error: { code: "cover_invalid_input", field, reason: "required" },
      });
    },
  );

  it.each([
    ["markup", "A <script>alert(1)</script> bedtime"],
    ["entity", "A &#x3c;script&#x3e; bedtime"],
    ["control", "A\u0000 bedtime"],
    ["bidi", "A\u202E bedtime"],
  ])("rejects %s in creator-authored copy", (_name, headline) => {
    const result = validateGuideCoverDraft({ ...validDraft, headline });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "cover_invalid_input", field: "headline" },
    });
  });

  it("returns normalized copy for rendering", () => {
    const result = validateGuideCoverDraft({
      ...validDraft,
      headline: "  Bedtime   can feel\n softer  ",
    });

    expect(result).toEqual({
      ok: true,
      value: { ...validDraft, headline: "Bedtime can feel softer" },
    });
  });

  it("accepts three-digit editions and rejects invalid editions", () => {
    expect(validateGuideCoverEdition(999)).toEqual({ ok: true, value: 999 });
    expect(validateGuideCoverEdition(0)).toEqual({
      ok: false,
      error: {
        code: "cover_invalid_input",
        field: "editionNumber",
        reason: "edition_range",
      },
    });
    expect(validateGuideCoverEdition(1000)).toEqual({
      ok: false,
      error: {
        code: "cover_invalid_input",
        field: "editionNumber",
        reason: "edition_range",
      },
    });
    expect(validateGuideCoverEdition(1.5)).toMatchObject({ ok: false });
  });
});
