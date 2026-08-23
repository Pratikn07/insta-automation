import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_ASSETS = [
  {
    filename: "source-serif-4-latin-400-normal.woff2",
    sha256: "02194deb92d3975dd30e11a3824a1f1db32b48c93654e60560cb81ce8e7b5f95",
  },
  {
    filename: "source-serif-4-latin-600-normal.woff2",
    sha256: "f2b7e1cf1d277b7608231868135648f8ad8e2b58d8e97ca088bee15dc357bee7",
  },
  {
    filename: "inter-latin-400-normal.woff2",
    sha256: "8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc",
  },
  {
    filename: "inter-latin-600-normal.woff2",
    sha256: "f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a",
  },
];

const sourceDirectory = fileURLToPath(
  new URL("../shared/guide-cover-assets/fonts/", import.meta.url),
);
const targetDirectory = fileURLToPath(
  new URL("../dist/shared/guide-cover-assets/fonts/", import.meta.url),
);

await mkdir(targetDirectory, { recursive: true });

for (const asset of FONT_ASSETS) {
  const sourcePath = join(sourceDirectory, asset.filename);
  const targetPath = join(targetDirectory, asset.filename);
  const sourceBytes = await readFile(sourcePath);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

  if (sourceHash !== asset.sha256) {
    throw new Error(`guide_cover_font_hash_mismatch:${asset.filename}`);
  }

  await copyFile(sourcePath, targetPath);

  const copiedBytes = await readFile(targetPath);
  const copiedHash = createHash("sha256").update(copiedBytes).digest("hex");
  if (copiedHash !== asset.sha256) {
    throw new Error(`guide_cover_font_copy_mismatch:${asset.filename}`);
  }
}
