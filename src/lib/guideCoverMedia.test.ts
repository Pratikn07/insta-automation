import { describe, expect, it, vi } from "vitest";

import { createGuideCoverHttpBucket, guideCoverHttpPublicUrl } from "./guideCoverMedia.js";

describe("guide cover HTTP media storage", () => {
  it("writes an immutable PNG through the authenticated gateway", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const bucket = createGuideCoverHttpBucket({
      baseUrl: "https://media.example.test/",
      writeToken: "secret-token",
      fetchImpl,
    });
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");

    await expect(
      bucket.upload("guide-cover/resource/cover/hash/dm.png", bytes, {
        cacheControl: "31536000, immutable",
        contentType: "image/png",
        upsert: false,
      }),
    ).resolves.toEqual({
      data: { path: "guide-cover/resource/cover/hash/dm.png" },
      error: null,
    });

    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://media.example.test/guide-cover/resource/cover/hash/dm.png");
    expect(request).toEqual(
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "cache-control": "31536000, immutable",
          "content-type": "image/png",
          "if-none-match": "*",
        }),
      }),
    );
    expect(Buffer.from(request?.body as Uint8Array)).toEqual(bytes);
  });

  it("maps an immutable-object collision to the storage conflict contract", async () => {
    const bucket = createGuideCoverHttpBucket({
      baseUrl: "https://media.example.test",
      writeToken: "secret-token",
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 409 })),
    });

    await expect(
      bucket.upload("guide-cover/resource/cover/hash/dm.png", Buffer.from("png"), {
        cacheControl: "31536000, immutable",
        contentType: "image/png",
        upsert: false,
      }),
    ).resolves.toEqual({ data: null, error: { statusCode: 409 } });
  });

  it("returns a Blob for an existing object and a stable 404 for a missing object", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(Buffer.from("png"), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const bucket = createGuideCoverHttpBucket({
      baseUrl: "https://media.example.test",
      writeToken: "secret-token",
      fetchImpl,
    });

    const found = await bucket.download("guide-cover/resource/cover/hash/dm.png");
    expect(found.error).toBeNull();
    expect(await found.data?.text()).toBe("png");
    await expect(bucket.download("guide-cover/missing.png")).resolves.toEqual({
      data: null,
      error: { statusCode: 404 },
    });
  });

  it("deletes only the requested path through the authenticated gateway", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const bucket = createGuideCoverHttpBucket({
      baseUrl: "https://media.example.test",
      writeToken: "secret-token",
      fetchImpl,
    });

    await expect(bucket.remove(["guide-cover/resource/cover/hash/dm.png"])).resolves.toEqual({
      data: ["guide-cover/resource/cover/hash/dm.png"],
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://media.example.test/guide-cover/resource/cover/hash/dm.png",
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer secret-token" },
      }),
    );
  });

  it("builds a public URL without a double slash", () => {
    expect(
      guideCoverHttpPublicUrl(
        "https://media.example.test/",
        "guide-cover/resource/cover/hash/square.png",
      ),
    ).toBe("https://media.example.test/guide-cover/resource/cover/hash/square.png");
  });
});
