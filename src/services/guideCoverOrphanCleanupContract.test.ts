import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runGuideCoverOrphanCleanupTick } from "./guideCoverOrphanCleanup.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-24T20:00:00.000Z");
const resourceId = randomUUID();
const firstCoverId = randomUUID();
const secondCoverId = randomUUID();
const firstOrphanId = randomUUID();
const secondOrphanId = randomUUID();
let prisma: PrismaClient;

function coverData(id: string, revision: number) {
  return {
    id,
    resourceId,
    revision,
    status: "approved" as const,
    categoryId: CATEGORY_ID,
    templateKey: "warm_editorial_corner_v1",
    paletteKey: "bedtime_blush_v1",
    illustrationKey: "bedtime_window_house_v1",
    kicker: "A TINY WIN FOR TONIGHT",
    collectionLabel: "SLEEP",
    headline: "Bedtime can feel softer",
    supportingLine: "A calmer bedtime, one small shift at a time.",
    closingLine: "Prepared for calmer evenings.",
    alternativeDescription: "A TinySoho bedtime guide cover.",
    approvedBy: "contract-test",
    approvedAt: NOW,
  };
}

function orphanData(id: string, coverVersionId: string, hash: string) {
  return {
    id,
    resourceId,
    coverVersionId,
    contentHash: hash,
    rendition: "dm_cover",
    storagePath: `guide-cover/${resourceId}/${coverVersionId}/${hash}/dm.png`,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.resource.create({
    data: { id: resourceId, name: "Guide cover orphan cleanup contract" },
  });
  await prisma.resourceCoverVersion.createMany({
    data: [coverData(firstCoverId, 1), coverData(secondCoverId, 2)],
  });
  await prisma.guideCoverOrphan.create({
    data: orphanData(firstOrphanId, firstCoverId, "a".repeat(64)),
  });
  await prisma.guideCoverOrphan.create({
    data: {
      ...orphanData(secondOrphanId, secondCoverId, "b".repeat(64)),
      status: "claimed",
      attempts: 5,
      claimedAt: new Date("2026-08-22T19:00:00.000Z"),
      claimExpiresAt: new Date("2026-08-22T19:10:00.000Z"),
    },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await prisma.guideCoverOrphan.deleteMany({ where: { resourceId } });
  await prisma.resourceCoverVersion.deleteMany({ where: { resourceId } });
  await prisma.resource.deleteMany({ where: { id: resourceId } });
  await prisma.$disconnect();
});

describeWithDatabase("guide cover orphan cleanup PostgreSQL behavior", () => {
  it("prevents two workers from claiming the same pending orphan", async () => {
    const removeExact = vi.fn(async () => ({ ok: true as const, outcome: "deleted" as const }));
    const options = {
      database: prisma,
      storage: { removeExact },
      batchSize: 1,
      now: () => NOW,
    };

    const results = await Promise.all([
      runGuideCoverOrphanCleanupTick(options),
      runGuideCoverOrphanCleanupTick(options),
    ]);

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(2);
    expect(removeExact).toHaveBeenCalledTimes(2);
    expect(new Set(removeExact.mock.calls.map(([path]) => path)).size).toBe(2);
    await expect(
      prisma.guideCoverOrphan.count({ where: { resourceId, status: "deleted" } }),
    ).resolves.toBe(2);
  });
});
