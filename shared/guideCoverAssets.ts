import { fileURLToPath } from "node:url";

export const GUIDE_COVER_FONT_ASSETS = [
  {
    family: "Source Serif 4",
    filename: "source-serif-4-latin-400-normal.woff2",
    style: "normal",
    weight: 400,
    sha256: "02194deb92d3975dd30e11a3824a1f1db32b48c93654e60560cb81ce8e7b5f95",
  },
  {
    family: "Source Serif 4",
    filename: "source-serif-4-latin-600-normal.woff2",
    style: "normal",
    weight: 600,
    sha256: "f2b7e1cf1d277b7608231868135648f8ad8e2b58d8e97ca088bee15dc357bee7",
  },
  {
    family: "Inter",
    filename: "inter-latin-400-normal.woff2",
    style: "normal",
    weight: 400,
    sha256: "8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc",
  },
  {
    family: "Inter",
    filename: "inter-latin-600-normal.woff2",
    style: "normal",
    weight: 600,
    sha256: "f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a",
  },
] as const;

export type GuideCoverFontFilename =
  (typeof GUIDE_COVER_FONT_ASSETS)[number]["filename"];

const REGISTERED_FILENAMES = new Set<string>(
  GUIDE_COVER_FONT_ASSETS.map((asset) => asset.filename),
);

export function resolveGuideCoverFontPath(filename: string): string {
  if (!REGISTERED_FILENAMES.has(filename)) {
    throw new Error("guide_cover_font_not_registered");
  }

  return fileURLToPath(
    new URL(`./guide-cover-assets/fonts/${filename}`, import.meta.url),
  );
}
