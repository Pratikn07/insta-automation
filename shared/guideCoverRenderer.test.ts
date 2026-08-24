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

  /**
   * The square rendition.
   *
   * It exists for one reason: Instagram's message-card image slot crops to roughly 1:1
   * and takes a CENTRE slice, so a landscape cover placed there loses its first letters.
   * Verified on device — the 1.91:1 rendition rendered "me can feel softer". The defence
   * is not a wider safe area, it is a source that is already square, which makes the crop
   * the identity function. So that is what these assert.
   */
  describe("square rendition", () => {
    const SLUGS = Object.keys(
      GUIDE_COVER_CATEGORIES,
    ) as GuideCoverCategorySlug[];

    it.each(SLUGS)("renders %s at exactly 1:1 so the card crop is a no-op", (slug) => {
      const result = layoutGuideCover(inputFor(slug), metrics, "square_card");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Stated as an equality rather than two literals: the whole guarantee is that the
      // two dimensions MATCH. A future 1200x1180 would still pass a pair of ~1200 checks
      // and would still be centre-cropped on device.
      expect(result.value.canvas.width).toBe(result.value.canvas.height);
      expect(result.value.canvas).toEqual({ width: 1200, height: 1200 });
    });

    /**
     * Every registered category has to survive BOTH renditions with the same copy.
     *
     * This is the test that would have caught the real bug: an earlier square moved the
     * artwork 48px left to fill the canvas, which narrowed the text column by the same
     * 48px, and `potty-training`'s supporting line wrapped to a third row and failed
     * `maxLines: 2`. The rendition returned cover_text_overflow for one category only —
     * invisible from any single-category test.
     */
    it.each(SLUGS)("lays %s out in both renditions from one set of copy", (slug) => {
      const landscape = layoutGuideCover(inputFor(slug), metrics, "dm_cover");
      const square = layoutGuideCover(inputFor(slug), metrics, "square_card");
      expect(landscape.ok).toBe(true);
      expect(square.ok).toBe(true);
      if (!landscape.ok || !square.ok) return;

      // The headline and the closing line INHERIT the landscape measure rather than
      // choosing their own, so copy that fits one fits the other by construction.
      for (const field of ["headline", "closingLine"] as const) {
        expect(square.value.text[field].maxWidth).toBe(
          landscape.value.text[field].maxWidth,
        );
      }

      // The supporting line is the deliberate exception: it may only ever GAIN measure.
      // Written as an inequality rather than an equality because the square gives the
      // corner templates a much wider column, and as a comparison rather than a literal
      // because a regression here is silent — a narrower measure still lays out, it just
      // wraps to more lines at a size chosen for fewer, and the overflow surfaces on
      // whichever single category happens to have the longest copy.
      expect(square.value.text.supportingLine.maxWidth).toBeGreaterThanOrEqual(
        landscape.value.text.supportingLine.maxWidth,
      );
    });

    /**
     * Nothing clipped at 1:1.
     *
     * Bounds are line boxes, not glyph outlines: `y` is a baseline, and every entry in
     * TYPOGRAPHY has lineHeight >= fontSize, so one lineHeight above the first baseline
     * covers the tallest ascender and one below the last covers the deepest descender.
     * A conservative box that passes is a stronger claim than an exact one that needs a
     * fudge factor to pass.
     */
    it.each(SLUGS)("keeps every %s text block inside the square frame", (slug) => {
      const result = layoutGuideCover(inputFor(slug), metrics, "square_card");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { canvas, text } = result.value;

      for (const [field, block] of Object.entries(text)) {
        const lastBaseline = block.y + block.lineHeight * (block.lines.length - 1);
        expect(block.y - block.lineHeight, `${field} top`).toBeGreaterThanOrEqual(0);
        expect(
          lastBaseline + block.lineHeight,
          `${field} bottom`,
        ).toBeLessThanOrEqual(canvas.height);

        // Horizontal, which flips with the anchor: `x` is the left edge for a start-anchored
        // block and the RIGHT edge for an end-anchored one, so the same comparison on both
        // would silently pass for the collection label while it ran off the canvas.
        const left =
          block.textAnchor === "end" ? block.x - block.maxWidth : block.x;
        const right =
          block.textAnchor === "end" ? block.x : block.x + block.maxWidth;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(canvas.width);
      }
    });

    /**
     * Only the closing line is checked here, and that is the whole point.
     *
     * The closing line sits low, genuinely beside the illustration, so a width clamp is
     * what keeps it clear and a width assertion can prove it. The supporting line sits
     * ABOVE the illustration and deliberately runs the full canvas width straight across
     * the artwork box — for it, a width assertion would be false, and the real guarantee
     * (no paint behind the text) is not visible from the layout at all, because the box's
     * upper region is reserved and empty. That one is asserted in pixels, in
     * `guideCoverPngRenderer.test.ts`.
     */
    it("keeps the square closing line clear of the corner artwork", () => {
      const result = layoutGuideCover(inputFor("bedtime"), metrics, "square_card");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { geometry, text } = result.value;

      expect(
        text.closingLine.x + text.closingLine.maxWidth,
      ).toBeLessThanOrEqual(geometry.artwork.x);
      // And the supporting line really does take the wider measure, so nobody reads the
      // absence of a clamp above as an oversight.
      expect(text.supportingLine.maxWidth).toBeGreaterThan(
        text.closingLine.maxWidth,
      );
    });

    /**
     * The scale, and where it is anchored.
     *
     * Illustrations draw at fixed pixel offsets from their box's top-left, so `height`
     * controls only the corner bleed and enlarging one is possible only by scaling. The
     * anchor is load-bearing and nothing else can catch it: these compositions are glued
     * to the canvas corner, so scaling about the centre instead would pull the artwork
     * inward and open a seam along two edges — a change that renders, looks plausible in
     * isolation, and is wrong.
     */
    it("scales corner artwork about the canvas corner it bleeds into", () => {
      const result = layoutGuideCover(inputFor("bedtime"), metrics, "square_card");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.geometry.artworkScale).toBe(1.31);
      const { x, y, width, height } = result.value.geometry.artwork;
      expect({ right: x + width, bottom: y + height }).toEqual({
        right: 1200,
        bottom: 1200,
      });
      expect(renderGuideCoverSvg(result.value)).toContain(
        'transform="translate(1200 1200) scale(1.31) translate(-1200 -1200)"',
      );
    });

    /**
     * The right panel is exempt. It is a filled rect already meeting three edges, so a
     * scale would only push its contents off-canvas — and its contents are what the
     * bottom-anchoring exists to keep visible.
     */
    it("leaves the Montessori right panel unscaled and bottom-anchored", () => {
      const result = layoutGuideCover(
        inputFor("montessori-activities"),
        metrics,
        "square_card",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.geometry.artworkScale).toBeUndefined();
      expect(result.value.geometry.artwork).toEqual({
        x: 804,
        y: 284,
        width: 396,
        height: 916,
      });
      // Bottom-anchored, so the tray sits in the visible lavender rather than above a
      // 520px void — the failure a 1200-tall panel produced.
      expect(
        result.value.geometry.artwork.y + result.value.geometry.artwork.height,
      ).toBe(result.value.canvas.height);
      expect(renderGuideCoverSvg(result.value)).not.toContain("scale(");
    });

    /**
     * The landscape cover must be untouched by all of the above. Its PNG hashes are
     * committed as release artifacts, so an accidental wrapper there would invalidate
     * them and make a real regression indistinguishable from this refactor.
     */
    it.each(SLUGS)("emits no transform wrapper for the %s DM cover", (slug) => {
      const result = layoutGuideCover(inputFor(slug), metrics, "dm_cover");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.geometry.artworkScale).toBeUndefined();
      expect(renderGuideCoverSvg(result.value)).not.toContain("scale(");
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
