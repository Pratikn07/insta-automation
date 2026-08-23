import { describe, expect, it, vi } from "vitest";

import {
  createGuideCoverCleanupStorage,
  validateGuideCoverObjectIdentity,
} from "./guideCoverCleanupStorage.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const PATH = `guide-cover/${RESOURCE_ID}/${COVER_ID}/${HASH}/dm.png`;

function bucket() {
  return { remove: vi.fn(), download: vi.fn() };
}

describe("guide cover cleanup storage", () => {
  it.each(["", "guide-cover/", "guide-cover/*", "../dm.png", `${PATH}/more`])(
    "rejects destructive or non-exact target %j",
    async (path) => {
      const storageBucket = bucket();
      const storage = createGuideCoverCleanupStorage({ bucket: storageBucket });

      await expect(storage.removeExact(path)).resolves.toEqual({
        ok: false,
        error: "cover_cleanup_invalid_path",
      });
      expect(storageBucket.remove).not.toHaveBeenCalled();
    },
  );

  it("deletes only the one validated content-hashed object", async () => {
    const storageBucket = bucket();
    storageBucket.remove.mockResolvedValue({ data: [PATH], error: null });
    const storage = createGuideCoverCleanupStorage({ bucket: storageBucket });

    await expect(storage.removeExact(PATH)).resolves.toEqual({
      ok: true,
      outcome: "deleted",
    });
    expect(storageBucket.remove).toHaveBeenCalledWith([PATH]);
  });

  it("treats a confirmed missing object as successful reconciliation", async () => {
    const storageBucket = bucket();
    storageBucket.remove.mockResolvedValue({ data: null, error: { statusCode: 500 } });
    storageBucket.download.mockResolvedValue({ data: null, error: { statusCode: 404 } });
    const storage = createGuideCoverCleanupStorage({ bucket: storageBucket });

    await expect(storage.removeExact(PATH)).resolves.toEqual({
      ok: true,
      outcome: "already_missing",
    });
    expect(storageBucket.download).toHaveBeenCalledWith(PATH);
  });

  it("fails closed when deletion and the exact-object probe are both uncertain", async () => {
    const storageBucket = bucket();
    storageBucket.remove.mockRejectedValue(new Error("private provider body"));
    storageBucket.download.mockRejectedValue(new Error("private provider body"));
    const storage = createGuideCoverCleanupStorage({ bucket: storageBucket });

    const result = await storage.removeExact(PATH);
    expect(result).toEqual({ ok: false, error: "cover_cleanup_outcome_unknown" });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });

  it("confirms the row identity matches the exact path before deletion", () => {
    expect(
      validateGuideCoverObjectIdentity({
        path: PATH,
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: HASH,
        rendition: "dm_cover",
      }),
    ).toBe(true);
    expect(
      validateGuideCoverObjectIdentity({
        path: PATH,
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: "b".repeat(64),
        rendition: "dm_cover",
      }),
    ).toBe(false);
  });
});
