/**
 * Render and store the square rendition for every already-published cover.
 *
 * A card's image slot centre-crops to roughly 1:1, so the card gate needs a square. Publish
 * only ever produced `dm_cover`, and until #50 the square could not be stored at all.
 *
 * A backfill rather than a change to `publishCoverVersion`: that transaction is the most
 * safety-critical code in this feature — durable intent before storage, upload outside the
 * transaction, exact-replay on retry, one edition per cover — and adding a second upload to it
 * introduces a partial-success path that deserves its own change. The 45 covers already
 * published need their squares either way, so this does that job and leaves the publish path
 * alone.
 *
 * Idempotent and `--dry-run` by default. The square's storage path is derived from the cover
 * version's OWN content_hash — the same hash as its dm sibling — because
 * `resource_cover_version_ready_render_check` pins it to exactly that. The hash is not
 * recomputed from the square bytes; a square is a rendition of one cover, not a new cover.
 */
import { PrismaClient } from "@prisma/client";

import { renderGuideCoverPng } from "../src/services/guideCoverPngRenderer.js";
import {
  createGuideCoverStorage,
  guideCoverStoragePath,
} from "../src/services/guideCoverStorage.js";
import type { GuideCoverRenderInput } from "../shared/guideCoverPolicy.js";

const prisma = new PrismaClient();
const storage = createGuideCoverStorage();
const apply = process.argv.includes("--apply");

const published = await prisma.resourceCoverVersion.findMany({
  where: { status: "published", renderStatus: "ready" },
  include: { category: true, resource: { select: { name: true } } },
  orderBy: { editionNumber: "asc" },
});

let stored = 0;
let skipped = 0;
let failed = 0;

for (const cover of published) {
  const label = `${cover.category.collectionLabel} · ${String(cover.editionNumber).padStart(2, "0")} ${cover.resource.name}`;

  if (cover.squareStoragePath) {
    console.log(`SKIP ${label}: already has a square`);
    skipped += 1;
    continue;
  }
  if (!cover.contentHash) {
    console.log(`FAIL ${label}: published without a content hash`);
    failed += 1;
    continue;
  }

  const input: GuideCoverRenderInput = {
    categorySlug: cover.category.slug as GuideCoverRenderInput["categorySlug"],
    editionNumber: cover.editionNumber ?? 1,
    kicker: cover.kicker,
    collectionLabel: cover.collectionLabel,
    templateKey: cover.templateKey as GuideCoverRenderInput["templateKey"],
    paletteKey: cover.paletteKey as GuideCoverRenderInput["paletteKey"],
    illustrationKey: cover.illustrationKey as GuideCoverRenderInput["illustrationKey"],
    headline: cover.headline,
    supportingLine: cover.supportingLine,
    closingLine: cover.closingLine,
    alternativeDescription: cover.alternativeDescription,
  };

  const rendered = await renderGuideCoverPng(input, "square_card");
  if (!rendered.ok) {
    console.log(`FAIL ${label}: render ${rendered.error.code}`);
    failed += 1;
    continue;
  }

  // Derived by the storage module, not hand-built, so it agrees with both the path pattern
  // and the CHECK constraint by construction.
  const path = guideCoverStoragePath({
    resourceId: cover.resourceId,
    coverVersionId: cover.id,
    contentHash: cover.contentHash,
    rendition: "square_card",
  });
  if (!path) {
    console.log(`FAIL ${label}: could not derive a storage path`);
    failed += 1;
    continue;
  }

  if (!apply) {
    console.log(`OK   ${label}: would store ${rendered.value.width}x${rendered.value.height}`);
    stored += 1;
    continue;
  }

  const put = await storage.upload({
    png: rendered.value.png,
    resourceId: cover.resourceId,
    coverVersionId: cover.id,
    contentHash: cover.contentHash,
    rendition: "square_card",
  });
  if (!put.ok) {
    console.log(`FAIL ${label}: storage ${put.error}`);
    failed += 1;
    continue;
  }

  // Fenced on squareStoragePath still being null, so two concurrent runs cannot both claim
  // to have written it. The CHECK constraint is the real guarantee that the path is correct;
  // this only guarantees one writer.
  const claimed = await prisma.resourceCoverVersion.updateMany({
    where: { id: cover.id, squareStoragePath: null },
    data: { squareStoragePath: path },
  });
  if (claimed.count !== 1) {
    console.log(`SKIP ${label}: another run claimed it first`);
    skipped += 1;
    continue;
  }
  console.log(`SQ   ${label}: stored`);
  stored += 1;
}

await prisma.$disconnect();
console.log(
  `\n${apply ? "APPLIED" : "DRY RUN"} — ${published.length} published covers | stored ${stored} | skipped ${skipped} | failed ${failed}`,
);
if (failed > 0) process.exitCode = 1;
