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
  { categorySlug: "bedtime", filename: "bedtime-warm-editorial.png" },
  {
    categorySlug: "potty-training",
    filename: "potty-training-sunlit-ritual.png",
  },
  { categorySlug: "recipes", filename: "recipes-corner-table.png" },
  {
    categorySlug: "montessori-activities",
    filename: "montessori-activities-discovery-tray.png",
  },
] as const satisfies ReadonlyArray<{
  categorySlug: GuideCoverCategorySlug;
  filename: string;
}>;

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
  const result = await renderGuideCoverPng(input, "dm_cover");
  if (!result.ok) {
    throw new Error(
      `guide_cover_snapshot_failed:${snapshot.categorySlug}:${result.error.code}`,
    );
  }

  await writeFile(`${OUTPUT_DIRECTORY}/${snapshot.filename}`, result.value.png);
  process.stdout.write(
    `${snapshot.filename} ${result.value.contentHash} ${result.value.pngHash}\n`,
  );
}
