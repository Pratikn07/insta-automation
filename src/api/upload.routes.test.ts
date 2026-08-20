import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSignedUploadUrl = vi.fn();

vi.mock("../lib/supabase.js", () => ({
  supabase: { storage: { from: () => ({ createSignedUploadUrl }) } },
  publicMediaUrl: (path: string) => `https://cdn.example.com/${path}`,
}));
vi.mock("../config/env.js", () => ({ env: { SUPABASE_BUCKET: "media" } }));

const { uploadRouter } = await import("./upload.routes.js");

const UPLOAD_ID = "50000000-0000-4000-8000-000000000001";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/upload", uploadRouter);
  return app;
}

beforeEach(() => {
  createSignedUploadUrl.mockReset().mockResolvedValue({
    data: { token: "token-1", signedUrl: "https://storage.example.com/upload?token=token-1" },
    error: null,
  });
});

/**
 * One upload intent owns one object path. If the path were minted server-side per
 * call, a PUT whose outcome was unknown could only be resolved by uploading to a
 * second path — leaving the first object orphaned and unverifiable.
 */
describe("signed upload paths", () => {
  it("derives the path from the client's UUID and the validated extension", async () => {
    const response = await request(makeApp())
      .post("/api/upload/sign")
      .send({ id: UPLOAD_ID, kind: "image", filename: "photo.PNG" })
      .expect(200);

    expect(response.body.path).toBe(`image/${UPLOAD_ID}.png`);
    expect(response.body.publicUrl).toBe(`https://cdn.example.com/image/${UPLOAD_ID}.png`);
    expect(createSignedUploadUrl).toHaveBeenCalledWith(`image/${UPLOAD_ID}.png`);
  });

  it("returns the identical path when the same intent re-signs", async () => {
    const body = { id: UPLOAD_ID, kind: "image" as const, filename: "photo.png" };

    const first = await request(makeApp()).post("/api/upload/sign").send(body).expect(200);
    const second = await request(makeApp()).post("/api/upload/sign").send(body).expect(200);

    expect(second.body.path).toBe(first.body.path);
  });

  it("requires the client UUID", async () => {
    await request(makeApp())
      .post("/api/upload/sign")
      .send({ kind: "image", filename: "photo.png" })
      .expect(400);

    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a header that disagrees with the body before signing", async () => {
    const response = await request(makeApp())
      .post("/api/upload/sign")
      .set("idempotency-key", "50000000-0000-4000-8000-000000000009")
      .send({ id: UPLOAD_ID, kind: "image", filename: "photo.png" })
      .expect(400);

    expect(response.body).toEqual({ error: "idempotency_key_mismatch" });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("falls back to a safe extension rather than trusting the filename", async () => {
    const response = await request(makeApp())
      .post("/api/upload/sign")
      .send({ id: UPLOAD_ID, kind: "pdf", filename: "no-extension" })
      .expect(200);

    expect(response.body.path).toBe(`pdf/${UPLOAD_ID}.pdf`);
  });

  it("rejects a path-traversal attempt in the extension", async () => {
    const response = await request(makeApp())
      .post("/api/upload/sign")
      .send({ id: UPLOAD_ID, kind: "image", filename: "x.../../etc/passwd" })
      .expect(200);

    // The extension is validated against a charset, so nothing but the fallback
    // can reach the storage key.
    expect(response.body.path).toBe(`image/${UPLOAD_ID}.jpg`);
  });

  it("reports a signing failure without inventing a path", async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: "denied" } });

    const response = await request(makeApp())
      .post("/api/upload/sign")
      .send({ id: UPLOAD_ID, kind: "image", filename: "photo.png" })
      .expect(500);

    expect(response.body.error).toBe("sign_failed");
  });
});
