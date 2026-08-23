import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  GUIDE_COVER_FONT_ASSETS,
  resolveGuideCoverFontPath,
} from "../../shared/guideCoverAssets.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("guide cover font asset contract", () => {
  it("pins the four allowlisted TinySoho font assets", () => {
    expect(GUIDE_COVER_FONT_ASSETS).toEqual([
      {
        family: "Source Serif 4",
        filename: "source-serif-4-latin-400-normal.woff2",
        style: "normal",
        weight: 400,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        family: "Source Serif 4",
        filename: "source-serif-4-latin-600-normal.woff2",
        style: "normal",
        weight: 600,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        family: "Inter",
        filename: "inter-latin-400-normal.woff2",
        style: "normal",
        weight: 400,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        family: "Inter",
        filename: "inter-latin-600-normal.woff2",
        style: "normal",
        weight: 600,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it.each(GUIDE_COVER_FONT_ASSETS)(
    "matches the recorded SHA-256 for $filename",
    async (asset) => {
      const path = resolveGuideCoverFontPath(asset.filename);
      const bytes = await readFile(path);

      expect(sha256(bytes)).toBe(asset.sha256);
    },
  );

  it("rejects filenames outside the committed allowlist", () => {
    expect(() => resolveGuideCoverFontPath("../../secret.txt")).toThrowError(
      "guide_cover_font_not_registered",
    );
  });
});
