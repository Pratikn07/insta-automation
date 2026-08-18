import { describe, expect, it, vi } from "vitest";
import { reconcileUpload, uploadSignedFile } from "./signedUpload";
import { RequestTimeoutError } from "./requestDeadline";

const UPLOAD_ID = "50000000-0000-4000-8000-000000000001";

function file(overrides: Partial<{ name: string; size: number; type: string }> = {}) {
  return {
    name: "photo.png",
    size: 1_024,
    type: "image/png",
    ...overrides,
  } as unknown as File;
}

function signed(path = `image/${UPLOAD_ID}.png`) {
  return {
    path,
    token: "token-1",
    signedUrl: "https://storage.example.com/upload?token=token-1",
    publicUrl: `https://cdn.example.com/${path}`,
  };
}

function headResponse(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
  } as unknown as Response;
}

describe("uploadSignedFile", () => {
  it("signs with the intent's UUID and PUTs to that path", async () => {
    const sign = vi.fn().mockResolvedValue(signed());
    const put = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);

    const result = await uploadSignedFile(
      { uploadId: UPLOAD_ID, kind: "image", file: file() },
      { sign, put },
    );

    expect(sign).toHaveBeenCalledWith({
      id: UPLOAD_ID,
      kind: "image",
      filename: "photo.png",
    });
    expect(result).toEqual({
      status: "uploaded",
      publicUrl: `https://cdn.example.com/image/${UPLOAD_ID}.png`,
    });
  });

  it("passes an abort signal so a stalled PUT does not hang forever", async () => {
    const put = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);

    await uploadSignedFile(
      { uploadId: UPLOAD_ID, kind: "image", file: file() },
      { sign: vi.fn().mockResolvedValue(signed()), put },
    );

    expect(put.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a storage 5xx", { status: 503, ok: false } as Response, undefined],
    ["a network failure", undefined, new TypeError("Failed to fetch")],
    ["a deadline", undefined, new RequestTimeoutError(120_000)],
    ["an abort", undefined, new DOMException("Aborted", "AbortError")],
  ])("reports %s as unknown rather than failed", async (_label, response, error) => {
    const put = error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(response as Response);

    const result = await uploadSignedFile(
      { uploadId: UPLOAD_ID, kind: "image", file: file() },
      { sign: vi.fn().mockResolvedValue(signed()), put },
    );

    // Unknown still carries the path: that is what makes the question answerable.
    expect(result).toEqual({
      status: "unknown",
      publicUrl: `https://cdn.example.com/image/${UPLOAD_ID}.png`,
    });
  });

  it("keeps a definite 4xx a definite failure", async () => {
    const put = vi.fn().mockResolvedValue({ status: 403, ok: false } as Response);

    await expect(
      uploadSignedFile(
        { uploadId: UPLOAD_ID, kind: "image", file: file() },
        { sign: vi.fn().mockResolvedValue(signed()), put },
      ),
    ).rejects.toThrow(/403/);
  });

  it("targets the same object path when the same intent uploads again", async () => {
    const sign = vi.fn().mockResolvedValue(signed());
    const put = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const input = { uploadId: UPLOAD_ID, kind: "image" as const, file: file() };

    const first = await uploadSignedFile(input, { sign, put });
    const second = await uploadSignedFile(input, { sign, put });

    expect(second.publicUrl).toBe(first.publicUrl);
    // Both signings carried the same id, so the server derived the same path.
    expect(sign.mock.calls[0][0].id).toBe(sign.mock.calls[1][0].id);
  });
});

describe("reconcileUpload", () => {
  it("confirms an object whose size and type match the file", async () => {
    const head = vi
      .fn()
      .mockResolvedValue(
        headResponse(200, { "content-length": "1024", "content-type": "image/png" }),
      );

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "confirmed", publicUrl: "https://cdn.example.com/x.png" });
  });

  it("reports a definite 404 as absence", async () => {
    const head = vi.fn().mockResolvedValue(headResponse(404));

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "absent" });
  });

  // The distinction the whole design turns on: a failed look is not an absence.
  it.each([
    ["a 403", headResponse(403), undefined],
    ["a 500", headResponse(500), undefined],
    ["a network failure", undefined, new TypeError("Failed to fetch")],
  ])("refuses to call %s an absence", async (_label, response, error) => {
    const head = error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(response as Response);

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "still_unknown" });
  });

  it("will not claim a match without a content length", async () => {
    const head = vi.fn().mockResolvedValue(headResponse(200, { "content-type": "image/png" }));

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "still_unknown" });
  });

  it("flags a different object at the same path", async () => {
    const head = vi
      .fn()
      .mockResolvedValue(
        headResponse(200, { "content-length": "99", "content-type": "image/png" }),
      );

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "mismatched" });
  });

  it("flags a type mismatch at a matching size", async () => {
    const head = vi
      .fn()
      .mockResolvedValue(
        headResponse(200, { "content-length": "1024", "content-type": "application/pdf" }),
      );

    await expect(
      reconcileUpload("https://cdn.example.com/x.png", file(), { head }),
    ).resolves.toEqual({ status: "mismatched" });
  });
});
