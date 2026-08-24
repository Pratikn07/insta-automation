import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { GuideCoverRenderInput } from "../shared/guideCoverPolicy.js";
import {
  GUIDE_COVER_CATEGORIES,
  type GuideCoverCategorySlug,
} from "../shared/guideCoverRegistry.js";
import { renderGuideCoverPng } from "../src/services/guideCoverPngRenderer.js";

const OUTPUT_DIRECTORY = fileURLToPath(
  new URL(
    "../docs/qa/artifacts/2026-08-22-guide-covers/",
    import.meta.url,
  ),
);

const SNAPSHOTS = [
  { categorySlug: "bedtime", stem: "bedtime-warm-editorial" },
  { categorySlug: "potty-training", stem: "potty-training-sunlit-ritual" },
  { categorySlug: "recipes", stem: "recipes-corner-table" },
  {
    categorySlug: "montessori-activities",
    stem: "montessori-activities-discovery-tray",
  },
] as const satisfies ReadonlyArray<{
  categorySlug: GuideCoverCategorySlug;
  stem: string;
}>;

/**
 * Both renditions, because they are judged in different places.
 *
 * `dm_cover` is a plain image message, which Instagram shows uncropped — so its
 * 1200x916 is what the parent sees. `square_card` rides in a generic template,
 * whose image slot Instagram centre-crops to 1:1; rendering it at 1200x1200
 * means the crop is a no-op. The pair is the point: the same copy has to survive
 * both, and only a side-by-side artifact shows whether it does.
 */
const RENDITIONS = [
  { rendition: "dm_cover", suffix: "" },
  { rendition: "square_card", suffix: "-square" },
] as const;

await mkdir(OUTPUT_DIRECTORY, { recursive: true });

for (const snapshot of SNAPSHOTS) {
  const category = GUIDE_COVER_CATEGORIES[snapshot.categorySlug];
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

  for (const { rendition, suffix } of RENDITIONS) {
    const result = await renderGuideCoverPng(input, rendition);
    if (!result.ok) {
      throw new Error(
        `guide_cover_snapshot_failed:${snapshot.categorySlug}:${rendition}:${result.error.code}`,
      );
    }

    const filename = `${snapshot.stem}${suffix}.png`;
    await writeFile(`${OUTPUT_DIRECTORY}/${filename}`, result.value.png);
    process.stdout.write(
      `${filename} ${result.value.contentHash} ${result.value.pngHash}\n`,
    );
  }
}
