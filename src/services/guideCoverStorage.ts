import type { GuideCoverRendition } from "../../shared/guideCoverPolicy.js";
import { publicMediaUrl, serverMediaBucket } from "../lib/supabase.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STORAGE_PATH_PATTERN = new RegExp(
  "^guide-cover/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[a-f0-9]{64}/(?:dm|generic)\\.png$",
  "u",
);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export interface GuideCoverStorageBucket {
  upload(
    path: string,
    bytes: Buffer,
    options: { cacheControl: string; contentType: string; upsert: boolean },
  ): Promise<{
    data: { path?: string } | null;
    error: { statusCode?: number | string; message?: string } | null;
  }>;
  download(path: string): Promise<{
    data: Blob | null;
    error: { statusCode?: number | string; message?: string } | null;
  }>;
}

export type GuideCoverStorageResult =
  | {
      ok: true;
      value: {
        outcome: "uploaded" | "reconciled";
        path: string;
        publicUrl: string;
      };
    }
  | {
      ok: false;
      error:
        | "cover_storage_conflict"
        | "cover_storage_failed"
        | "cover_storage_invalid_identity"
        | "cover_storage_invalid_png"
        | "cover_storage_outcome_unknown";
    };

export interface UploadGuideCoverInput {
  resourceId: string;
  coverVersionId: string;
  contentHash: string;
  rendition: GuideCoverRendition;
  png: Buffer;
}

export function guideCoverStoragePath(
  input: Omit<UploadGuideCoverInput, "png">,
): string | null {
  if (
    !UUID_PATTERN.test(input.resourceId) ||
    !UUID_PATTERN.test(input.coverVersionId) ||
    !HASH_PATTERN.test(input.contentHash)
  ) {
    return null;
  }
  const filename = input.rendition === "dm_cover" ? "dm.png" : "generic.png";
  return `guide-cover/${input.resourceId.toLowerCase()}/${input.coverVersionId.toLowerCase()}/${input.contentHash}/${filename}`;
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function isConflictStatus(statusCode: number | string | undefined): boolean {
  return Number(statusCode) === 409;
}

export function createGuideCoverStorage(options: {
  bucket?: GuideCoverStorageBucket;
  publicUrl?: (path: string) => string;
} = {}) {
  const bucket =
    options.bucket ?? (serverMediaBucket() as unknown as GuideCoverStorageBucket);
  const publicUrl = options.publicUrl ?? publicMediaUrl;

  return {
    async verifyExact(
      path: string,
    ): Promise<
      | { ok: true; exists: boolean }
      | { ok: false; error: "cover_storage_invalid_identity" | "cover_storage_outcome_unknown" }
    > {
      if (!STORAGE_PATH_PATTERN.test(path)) {
        return { ok: false, error: "cover_storage_invalid_identity" };
      }
      try {
        const existing = await bucket.download(path);
        if (!existing.error && existing.data) return { ok: true, exists: true };
        if (Number(existing.error?.statusCode) === 404) {
          return { ok: true, exists: false };
        }
        return { ok: false, error: "cover_storage_outcome_unknown" };
      } catch {
        return { ok: false, error: "cover_storage_outcome_unknown" };
      }
    },

    async upload(input: UploadGuideCoverInput): Promise<GuideCoverStorageResult> {
      const path = guideCoverStoragePath(input);
      if (!path) return { ok: false, error: "cover_storage_invalid_identity" };
      if (!isPng(input.png)) {
        return { ok: false, error: "cover_storage_invalid_png" };
      }
      try {
        const uploaded = await bucket.upload(path, input.png, {
          cacheControl: "31536000, immutable",
          contentType: "image/png",
          upsert: false,
        });
        if (!uploaded.error && uploaded.data) {
          return {
            ok: true,
            value: { outcome: "uploaded", path, publicUrl: publicUrl(path) },
          };
        }
        if (!isConflictStatus(uploaded.error?.statusCode)) {
          return { ok: false, error: "cover_storage_failed" };
        }

        const existing = await bucket.download(path);
        if (existing.error || !existing.data) {
          return { ok: false, error: "cover_storage_outcome_unknown" };
        }
        const existingBytes = Buffer.from(await existing.data.arrayBuffer());
        if (!existingBytes.equals(input.png)) {
          return { ok: false, error: "cover_storage_conflict" };
        }
        return {
          ok: true,
          value: { outcome: "reconciled", path, publicUrl: publicUrl(path) },
        };
      } catch {
        return { ok: false, error: "cover_storage_outcome_unknown" };
      }
    },
  };
}

export type GuideCoverStorage = ReturnType<typeof createGuideCoverStorage>;
