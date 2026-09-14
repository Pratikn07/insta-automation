import {
  GUIDE_COVER_RENDITION_FILENAMES,
  type GuideCoverRendition,
} from "../../shared/guideCoverPolicy.js";
import { guideCoverMediaBucket } from "../lib/guideCoverProvider.js";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Alternation derived from the shared filename map: a rendition the path builder can write
// must be one cleanup can parse, or its orphans become unreclaimable.
const RENDITION_FILES = Object.values(GUIDE_COVER_RENDITION_FILENAMES)
  .map((filename) => filename.replace(/\.png$/u, ""))
  .join("|");
const PATH_PATTERN = new RegExp(
  `^guide-cover/(${UUID_SOURCE})/(${UUID_SOURCE})/([a-f0-9]{64})/(${RENDITION_FILES})\\.png$`,
  "u",
);

export interface GuideCoverCleanupBucket {
  remove(paths: string[]): Promise<{
    data: unknown;
    error: { statusCode?: number | string; message?: string } | null;
  }>;
  download(path: string): Promise<{
    data: Blob | null;
    error: { statusCode?: number | string; message?: string } | null;
  }>;
}

export type GuideCoverCleanupStorageResult =
  | { ok: true; outcome: "deleted" | "already_missing" }
  | {
      ok: false;
      error:
        | "cover_cleanup_invalid_path"
        | "cover_cleanup_delete_failed"
        | "cover_cleanup_outcome_unknown";
    };

export type GuideCoverCleanupProbeResult =
  | { ok: true; exists: boolean }
  | {
      ok: false;
      error: "cover_cleanup_invalid_path" | "cover_cleanup_outcome_unknown";
    };

export interface GuideCoverObjectIdentity {
  path: string;
  resourceId: string;
  coverVersionId: string;
  contentHash: string;
  rendition: string;
}

export function validateGuideCoverObjectIdentity(
  identity: GuideCoverObjectIdentity,
): boolean {
  const match = PATH_PATTERN.exec(identity.path);
  if (!match) return false;
  // Shared map, so a rendition the path builder can write is a rendition cleanup can
  // reclaim. When these disagreed, an orphaned square was unreclaimable forever: the
  // identity came back invalid and cleanup refused to delete, silently.
  const expectedFilename =
    GUIDE_COVER_RENDITION_FILENAMES[identity.rendition as GuideCoverRendition]?.replace(
      /\.png$/u,
      "",
    ) ?? null;
  return (
    expectedFilename !== null &&
    match[1] === identity.resourceId &&
    match[2] === identity.coverVersionId &&
    match[3] === identity.contentHash &&
    match[4] === expectedFilename
  );
}

function exactPath(path: string): boolean {
  return PATH_PATTERN.test(path);
}

function isNotFound(error: { statusCode?: number | string } | null): boolean {
  return Number(error?.statusCode) === 404;
}

export function createGuideCoverCleanupStorage(options: {
  bucket?: GuideCoverCleanupBucket;
} = {}) {
  const bucket =
    options.bucket ?? (guideCoverMediaBucket() as unknown as GuideCoverCleanupBucket);

  async function reconcileExactPath(
    path: string,
  ): Promise<GuideCoverCleanupStorageResult> {
    try {
      const probe = await bucket.download(path);
      if (probe.data && !probe.error) {
        return { ok: false, error: "cover_cleanup_delete_failed" };
      }
      if (isNotFound(probe.error)) {
        return { ok: true, outcome: "already_missing" };
      }
      return { ok: false, error: "cover_cleanup_outcome_unknown" };
    } catch {
      return { ok: false, error: "cover_cleanup_outcome_unknown" };
    }
  }

  return {
    async probeExact(path: string): Promise<GuideCoverCleanupProbeResult> {
      if (!exactPath(path)) {
        return { ok: false, error: "cover_cleanup_invalid_path" };
      }
      try {
        const probe = await bucket.download(path);
        if (probe.data && !probe.error) return { ok: true, exists: true };
        if (isNotFound(probe.error)) return { ok: true, exists: false };
        return { ok: false, error: "cover_cleanup_outcome_unknown" };
      } catch {
        return { ok: false, error: "cover_cleanup_outcome_unknown" };
      }
    },

    async removeExact(path: string): Promise<GuideCoverCleanupStorageResult> {
      if (!exactPath(path)) {
        return { ok: false, error: "cover_cleanup_invalid_path" };
      }
      try {
        const removed = await bucket.remove([path]);
        if (!removed.error) return { ok: true, outcome: "deleted" };
      } catch {
        // The exact-path probe below determines whether the thrown request landed.
      }
      return reconcileExactPath(path);
    },
  };
}

export type GuideCoverCleanupStorage = ReturnType<
  typeof createGuideCoverCleanupStorage
>;
