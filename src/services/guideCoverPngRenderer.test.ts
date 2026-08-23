import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { GuideCoverRenderInput } from "../../shared/guideCoverPolicy.js";
import {
  GUIDE_COVER_CATEGORIES,
  type GuideCoverCategorySlug,
} from "../../shared/guideCoverRegistry.js";
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
      "6e32a066e0d2c66f991729fcc109ebad0b95e0dfb96ec5a6be98c47a0d2233d4",
    ],
    [
      "potty-training",
      "9cea8b2d9b00e7ed22c746a5e4b4b308a6aa2699f746e7f52317fe13af86905e",
    ],
    [
      "recipes",
      "5b75351397be0701b50856313c90f6f9788841909c2e47df78b68e37c9013741",
    ],
    [
      "montessori-activities",
      "0a7c85b3cd2b31f4392cb8947853871dc02368cf2f82d4f80cf83bd00a173245",
    ],
  ] as const)("matches the approved %s PNG snapshot", async (slug, pngHash) => {
    const result = await renderGuideCoverPng(inputFor(slug), "dm_cover");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pngHash).toBe(pngHash);
  });
});
