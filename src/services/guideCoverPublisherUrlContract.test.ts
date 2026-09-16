import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const publisherSource = readFileSync(
  new URL("../../scripts/publish-guide-covers.ts", import.meta.url),
  "utf8",
);

describe("guide cover publisher URL contract", () => {
  it("attaches the configured guide-cover media URL to authored messages", () => {
    expect(publisherSource).toContain(
      'import { guideCoverPublicUrl } from "../src/lib/guideCoverProvider.js";',
    );
    expect(publisherSource).toContain("guideCoverPublicUrl(cover.dmStoragePath)");
    expect(publisherSource).not.toContain("publicMediaUrl(cover.dmStoragePath)");
  });
});
