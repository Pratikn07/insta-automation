import { describe, expect, it, vi } from "vitest";

import { createGuideCoverStorage } from "./guideCoverStorage.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
// The content hash covers normalized publication input, renderer version, and
// font hashes. It is intentionally not the PNG byte hash.
const HASH = "a".repeat(64);
const PATH = `guide-cover/${RESOURCE_ID}/${COVER_ID}/${HASH}/dm.png`;

function dependencies() {
  return {
    bucket: {
      download: vi.fn(),
      upload: vi.fn(),
    },
    publicUrl: vi.fn((path: string) => `https://cdn.example/${path}`),
  };
}

describe("guide cover storage", () => {
  it("uploads to the fully derived immutable path", async () => {
    const deps = dependencies();
    deps.bucket.upload.mockResolvedValue({ data: { path: PATH }, error: null });
    const storage = createGuideCoverStorage(deps);

    await expect(
      storage.upload({
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: HASH,
        rendition: "dm_cover",
        png: PNG,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        outcome: "uploaded",
        path: PATH,
        publicUrl: `https://cdn.example/${PATH}`,
      },
    });
    expect(deps.bucket.upload).toHaveBeenCalledWith(PATH, PNG, {
      cacheControl: "31536000, immutable",
      contentType: "image/png",
      upsert: false,
    });
  });

  it("reconciles an existing object only when its bytes match", async () => {
    const deps = dependencies();
    deps.bucket.upload.mockResolvedValue({
      data: null,
      error: { statusCode: "409", message: "private provider body" },
    });
    deps.bucket.download.mockResolvedValue({ data: new Blob([PNG]), error: null });
    const storage = createGuideCoverStorage(deps);

    await expect(
      storage.upload({
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: HASH,
        rendition: "dm_cover",
        png: PNG,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { outcome: "reconciled", path: PATH },
    });
    expect(deps.bucket.download).toHaveBeenCalledWith(PATH);
  });

  it("fails closed when an existing object has different bytes", async () => {
    const deps = dependencies();
    deps.bucket.upload.mockResolvedValue({ data: null, error: { statusCode: 409 } });
    deps.bucket.download.mockResolvedValue({
      data: new Blob([Buffer.from("different")]),
      error: null,
    });
    const storage = createGuideCoverStorage(deps);

    await expect(
      storage.upload({
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: HASH,
        rendition: "dm_cover",
        png: PNG,
      }),
    ).resolves.toEqual({ ok: false, error: "cover_storage_conflict" });
  });

  it("rejects non-PNG input before contacting Storage", async () => {
    const deps = dependencies();
    const storage = createGuideCoverStorage(deps);

    await expect(
      storage.upload({
        resourceId: RESOURCE_ID,
        coverVersionId: COVER_ID,
        contentHash: HASH,
        rendition: "dm_cover",
        png: Buffer.from("not a png"),
      }),
    ).resolves.toEqual({ ok: false, error: "cover_storage_invalid_png" });
    expect(deps.bucket.upload).not.toHaveBeenCalled();
  });

  it("returns a stable error without exposing the provider response", async () => {
    const deps = dependencies();
    deps.bucket.upload.mockResolvedValue({
      data: null,
      error: { statusCode: 500, message: "service key leaked in provider body" },
    });
    const storage = createGuideCoverStorage(deps);

    const result = await storage.upload({
      resourceId: RESOURCE_ID,
      coverVersionId: COVER_ID,
      contentHash: HASH,
      rendition: "dm_cover",
      png: PNG,
    });
    expect(result).toEqual({ ok: false, error: "cover_storage_failed" });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });
});
