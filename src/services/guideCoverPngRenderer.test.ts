import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";

import type { GuideCoverRenderInput } from "../../shared/guideCoverPolicy.js";
import {
  GUIDE_COVER_CATEGORIES,
  type GuideCoverCategorySlug,
} from "../../shared/guideCoverRegistry.js";
import {
  layoutGuideCover,
  type GuideCoverFontMetrics,
} from "../../shared/guideCoverRenderer.js";
import {
  GUIDE_COVER_RENDERER_VERSION,
  renderGuideCoverPng,
} from "./guideCoverPngRenderer.js";

const category = GUIDE_COVER_CATEGORIES.bedtime;
const input: GuideCoverRenderInput = {
  categorySlug: category.categorySlug,
  editionNumber: 1,
  kicker: category.defaultKicker,
  collectionLabel: category.collectionLabel,
  templateKey: category.templateKey,
  paletteKey: category.paletteKey,
  illustrationKey: category.illustrationKey,
  ...category.exampleCopy,
};

function inputFor(categorySlug: GuideCoverCategorySlug): GuideCoverRenderInput {
  const selected = GUIDE_COVER_CATEGORIES[categorySlug];
  return {
    categorySlug,
    editionNumber: 1,
    kicker: selected.defaultKicker,
    collectionLabel: selected.collectionLabel,
    templateKey: selected.templateKey,
    paletteKey: selected.paletteKey,
    illustrationKey: selected.illustrationKey,
    ...selected.exampleCopy,
  };
}

describe("guide cover PNG renderer", () => {
  it("renders deterministic canonical PNG bytes and a normalized hash", async () => {
    const first = await renderGuideCoverPng(input, "dm_cover");
    const second = await renderGuideCoverPng(input, "dm_cover");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.rendererVersion).toBe(GUIDE_COVER_RENDERER_VERSION);
    expect(first.value.width).toBe(1200);
    expect(first.value.height).toBe(916);
    expect(first.value.filename).toBe("dm.png");
    expect(first.value.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.value.contentHash).toBe(second.value.contentHash);
    expect(first.value.png.equals(second.value.png)).toBe(true);
    expect(first.value.png.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(createHash("sha256").update(first.value.png).digest("hex")).toBe(
      first.value.pngHash,
    );
    expect(first.value.svg).not.toContain("<text");
  });

  it("changes the content hash when normalized publication input changes", async () => {
    const first = await renderGuideCoverPng(input, "dm_cover");
    const changed = await renderGuideCoverPng(
      { ...input, editionNumber: 2 },
      "dm_cover",
    );

    expect(first.ok).toBe(true);
    expect(changed.ok).toBe(true);
    if (!first.ok || !changed.ok) return;

    expect(changed.value.contentHash).not.toBe(first.value.contentHash);
    expect(changed.value.png.equals(first.value.png)).toBe(false);
  });

  it("keeps the generic-card composition available but separately identified", async () => {
    const result = await renderGuideCoverPng(input, "generic_card");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filename).toBe("generic.png");
    expect(result.value.rendition).toBe("generic_card");
    expect(result.value.width).toBe(1200);
    expect(result.value.height).toBe(628);
  });

  it.each([
    [
      "bedtime",
      "577eee46948d5b9a559473e7b0d75815ddb10d06cc9709da7517b1bd1b2ee858",
    ],
    [
      "potty-training",
      "fc35592931d08c9e21d7512f788ae2d241dfe020461e17ea19fc27412afb6f09",
    ],
    [
      "recipes",
      "5b75351397be0701b50856313c90f6f9788841909c2e47df78b68e37c9013741",
    ],
    [
      "montessori-activities",
      "58b5f8bbd69f6554b4fe8c2f6e85d369d029b515d0c404045d194d2c960752d3",
    ],
  ] as const)("matches the approved %s PNG snapshot", async (slug, pngHash) => {
    const result = await renderGuideCoverPng(inputFor(slug), "dm_cover");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pngHash).toBe(pngHash);
  });

  /**
   * The square's supporting line runs the FULL width of the canvas, straight across the
   * artwork box, and is safe only because the illustration's ink begins below it. Every
   * other guarantee in this feature is a width clamp that can be asserted from the layout;
   * this one cannot, because the artwork box's upper region is empty — the corner
   * compositions fill a triangle from their hypotenuse down and to the right, so the box
   * says "reserved" where nothing is drawn.
   *
   * So this checks the actual claim in pixels: no illustration colour appears anywhere in
   * the rows the supporting line occupies. It fails if the artwork scale grows, if
   * supportTop moves down, or if an illustration's internal offsets shift upward — three
   * independent changes that each render without error and each put a paint colour behind
   * the one line the square exists to make readable.
   */
  it.each(["bedtime", "potty-training", "recipes"] as const)(
    "keeps illustration ink out of the %s square's supporting line",
    async (slug) => {
      const category = GUIDE_COVER_CATEGORIES[slug];
      const result = await renderGuideCoverPng(inputFor(slug), "square_card");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const pixmap = decodePng(result.value.png, result.value.width, result.value.height);
      const { pixels, width } = pixmap;

      const support = supportingLineBand(slug);
      // Bounded by line boxes for the same reason the layout test uses them: lineHeight >=
      // fontSize for every entry in TYPOGRAPHY, so one above the first baseline covers the
      // tallest ascender and one below the last covers the deepest descender. Assumes the
      // maximum two lines rather than reading the wrapped count, so the band cannot narrow
      // when copy shortens — erring wide makes a pass mean more.
      const firstRow = Math.max(0, support.y - support.lineHeight);
      const lastRow = Math.min(
        result.value.height - 1,
        support.y + support.lineHeight * 2,
      );

      // Paint colours only. `background` is the paper the text sits on and `ink` is the
      // text itself, so both must be excluded or every row would "fail".
      const paint = [
        category.renderColors.surface,
        category.renderColors.artPrimary,
        category.renderColors.artSecondary,
        category.renderColors.accent,
      ].map(hexToRgb);

      const intrusions: string[] = [];
      for (let y = firstRow; y <= lastRow; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const found = paint.find(
            (colour) =>
              pixels[offset] === colour.r &&
              pixels[offset + 1] === colour.g &&
              pixels[offset + 2] === colour.b &&
              pixels[offset + 3] === 255,
          );
          if (found) intrusions.push(`(${x},${y})`);
        }
      }

      expect(
        intrusions.slice(0, 5),
        `illustration ink inside rows ${firstRow}-${lastRow}`,
      ).toEqual([]);
    },
  );
});

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * Decodes the PUBLISHED png bytes rather than re-rendering the SVG, by handing them back to
 * Resvg wrapped in an `<image>`. Re-rendering would test a second render of the same
 * layout; this tests the artifact that actually reaches a parent. Resvg is already a
 * dependency, so this adds no decoder.
 */
function decodePng(
  png: Buffer,
  width: number,
  height: number,
): { pixels: Buffer; width: number } {
  const wrapper =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}">` +
    `<image width="${width}" height="${height}" ` +
    `xlink:href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
  const pixmap = new Resvg(wrapper).render();
  return { pixels: pixmap.pixels, width: pixmap.width };
}

/**
 * Where the square's supporting line sits, taken from the layout rather than hardcoded, so
 * moving `supportTop` moves the band this checks instead of leaving it checking empty rows.
 * The synthetic metric is fine here: `y` and `lineHeight` are set by the rendition's
 * geometry and type scale, neither of which depends on how wide the glyphs measure.
 */
function supportingLineBand(slug: GuideCoverCategorySlug): {
  y: number;
  lineHeight: number;
} {
  const laid = layoutGuideCover(inputFor(slug), SYNTHETIC_METRICS, "square_card");
  if (!laid.ok) throw new Error(`layout_failed:${slug}:${laid.error.code}`);
  const { y, lineHeight } = laid.value.text.supportingLine;
  return { y, lineHeight };
}

const SYNTHETIC_METRICS: GuideCoverFontMetrics = {
  measureText({ family, fontSize, letterSpacing, text }) {
    const factor = family === "Source Serif 4" ? 0.52 : 0.5;
    return (
      [...text].length * fontSize * factor +
      Math.max(0, [...text].length - 1) * letterSpacing
    );
  },
};
