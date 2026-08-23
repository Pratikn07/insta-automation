import { describe, expect, it } from "vitest";

import type { GuideCoverRenderInput } from "./guideCoverPolicy.js";
import {
  GUIDE_COVER_CATEGORIES,
  type GuideCoverCategorySlug,
} from "./guideCoverRegistry.js";
import {
  layoutGuideCover,
  renderGuideCoverSvg,
  type GuideCoverFontMetrics,
} from "./guideCoverRenderer.js";

const metrics: GuideCoverFontMetrics = {
  measureText({ family, fontSize, letterSpacing, text }) {
    const factor = family === "Source Serif 4" ? 0.52 : 0.5;
    return (
      [...text].length * fontSize * factor +
      Math.max(0, [...text].length - 1) * letterSpacing
    );
  },
};

function inputFor(
  categorySlug: GuideCoverCategorySlug,
  overrides: Partial<GuideCoverRenderInput> = {},
): GuideCoverRenderInput {
  const category = GUIDE_COVER_CATEGORIES[categorySlug];
  return {
    categorySlug,
    editionNumber: 1,
    kicker: category.defaultKicker,
    collectionLabel: category.collectionLabel,
    templateKey: category.templateKey,
    paletteKey: category.paletteKey,
    illustrationKey: category.illustrationKey,
    ...category.exampleCopy,
    ...overrides,
  };
}

describe("guide cover layout", () => {
  it("keeps corner artwork outside the support and closing safe areas", () => {
    const result = layoutGuideCover(inputFor("bedtime"), metrics, "dm_cover");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.canvas).toEqual({ width: 1200, height: 916 });
    expect(result.value.geometry.artwork).toEqual({
      x: 684,
      y: 385,
      width: 516,
      height: 531,
    });
    expect(
      result.value.text.supportingLine.x +
        result.value.text.supportingLine.maxWidth,
    ).toBeLessThan(result.value.geometry.artwork.x);
    expect(
      result.value.text.closingLine.x + result.value.text.closingLine.maxWidth,
    ).toBeLessThan(result.value.geometry.artwork.x);
    expect(result.value.text.headline.y).toBe(192);
    expect(result.value.text.supportingLine.y).toBe(467);
  });

  it("keeps Montessori artwork in a full-height right panel", () => {
    const result = layoutGuideCover(
      inputFor("montessori-activities"),
      metrics,
      "dm_cover",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.geometry.artwork).toEqual({
      x: 804,
      y: 0,
      width: 396,
      height: 916,
    });
    expect(result.value.category.artworkPlacement).toBe("right");
    expect(
      result.value.text.headline.x + result.value.text.headline.maxWidth,
    ).toBeLessThan(result.value.geometry.artwork.x);
    expect(
      result.value.text.supportingLine.x +
        result.value.text.supportingLine.maxWidth,
    ).toBeLessThan(result.value.geometry.artwork.x);
  });

  it("lays out a three-digit edition without changing registered copy", () => {
    const result = layoutGuideCover(
      inputFor("recipes", { editionNumber: 107 }),
      metrics,
      "dm_cover",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.editionLabel).toBe("RECIPES · 107");
    expect(result.value.text.collectionLabel.lines).toEqual(["RECIPES · 107"]);
  });

  it.each([
    "A <script>alert(1)</script> bedtime",
    "A &#x3c;script&#x3e; bedtime",
    "data:image/svg+xml,malicious",
    "A\u202E bedtime",
  ])("fails closed for malicious headline %s", (headline) => {
    const result = layoutGuideCover(
      inputFor("bedtime", { headline }),
      metrics,
      "dm_cover",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "cover_invalid_input", field: "headline" },
    });
  });

  it("returns cover_text_overflow instead of shrinking an unbroken token", () => {
    const result = layoutGuideCover(
      inputFor("bedtime", { headline: "W".repeat(40) }),
      metrics,
      "dm_cover",
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "cover_text_overflow", field: "headline" },
    });
  });

  it("produces stable, self-contained SVG with the registered illustration", () => {
    const first = layoutGuideCover(inputFor("potty-training"), metrics, "dm_cover");
    const second = layoutGuideCover(inputFor("potty-training"), metrics, "dm_cover");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstSvg = renderGuideCoverSvg(first.value);
    const secondSvg = renderGuideCoverSvg(second.value);

    expect(firstSvg).toBe(secondSvg);
    expect(firstSvg).toContain('width="1200" height="916"');
    expect(firstSvg).toContain('data-illustration="potty_sunlit_ritual_v1"');
    expect(firstSvg).not.toMatch(/(?:href|src)="https?:\/\//u);
    expect(firstSvg).not.toContain("<script");
    expect(firstSvg).not.toMatch(/toilet|underwear|stool/iu);
  });
});
