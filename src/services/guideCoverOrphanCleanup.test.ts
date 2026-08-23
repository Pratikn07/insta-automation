import { describe, expect, it, vi } from "vitest";

import { runGuideCoverOrphanCleanupTick } from "./guideCoverOrphanCleanup.js";

const NOW = new Date("2026-08-22T20:00:00.000Z");
const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const COVER_ID = "30000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const PATH = `guide-cover/${RESOURCE_ID}/${COVER_ID}/${HASH}/dm.png`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    resourceId: RESOURCE_ID,
    coverVersionId: COVER_ID,
    contentHash: HASH,
    rendition: "dm_cover",
    storagePath: PATH,
    attempts: 1,
    claimedAt: NOW,
    ...overrides,
  };
}

function fixture(rows = [row()]) {
  const database = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    guideCoverOrphan: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const storage = {
    removeExact: vi.fn().mockResolvedValue({ ok: true, outcome: "deleted" }),
  };
  return { database, storage };
}

describe("guide cover orphan cleanup", () => {
  it("claims a bounded batch and checkpoints exact-path deletion", async () => {
    const { database, storage } = fixture();

    await expect(
      runGuideCoverOrphanCleanupTick({
        database: database as never,
        storage,
        batchSize: 8,
        now: () => NOW,
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 1, retried: 0, needsReview: 0 });

    expect(storage.removeExact).toHaveBeenCalledWith(PATH);
    expect(database.guideCoverOrphan.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, status: "claimed", claimedAt: NOW },
      data: expect.objectContaining({
        status: "deleted",
        deletedAt: NOW,
        claimedAt: null,
        claimExpiresAt: null,
      }),
    });
  });

  it("retries a transient exact-object failure with a bounded backoff", async () => {
    const { database, storage } = fixture([row({ attempts: 2 })]);
    storage.removeExact.mockResolvedValue({ ok: false, error: "cover_cleanup_delete_failed" });

    await expect(
      runGuideCoverOrphanCleanupTick({
        database: database as never,
        storage,
        batchSize: 8,
        now: () => NOW,
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 0, retried: 1, needsReview: 0 });

    expect(database.guideCoverOrphan.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, status: "claimed", claimedAt: NOW },
      data: expect.objectContaining({
        status: "pending",
        attempts: 2,
        lastErrorCode: "cover_cleanup_delete_failed",
        nextAttemptAt: new Date("2026-08-22T20:10:00.000Z"),
      }),
    });
  });

  it("sends an exhausted cleanup to owner review", async () => {
    const { database, storage } = fixture([row({ attempts: 5 })]);
    storage.removeExact.mockResolvedValue({ ok: false, error: "cover_cleanup_outcome_unknown" });

    await expect(
      runGuideCoverOrphanCleanupTick({
        database: database as never,
        storage,
        batchSize: 8,
        now: () => NOW,
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 0, retried: 0, needsReview: 1 });

    expect(database.guideCoverOrphan.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, status: "claimed", claimedAt: NOW },
      data: expect.objectContaining({ status: "needs_review", attempts: 5 }),
    });
  });

  it("never contacts Storage when the claimed row and path identities disagree", async () => {
    const { database, storage } = fixture([row({ contentHash: "b".repeat(64) })]);

    await expect(
      runGuideCoverOrphanCleanupTick({
        database: database as never,
        storage,
        batchSize: 8,
        now: () => NOW,
      }),
    ).resolves.toEqual({ claimed: 1, deleted: 0, retried: 0, needsReview: 1 });

    expect(storage.removeExact).not.toHaveBeenCalled();
    expect(database.guideCoverOrphan.updateMany).toHaveBeenCalledWith({
      where: { id: row().id, status: "claimed", claimedAt: NOW },
      data: expect.objectContaining({
        status: "needs_review",
        lastErrorCode: "cover_cleanup_invalid_path",
      }),
    });
  });
});
