import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGuideCoverCollectionMoveService } from "./guideCoverCollectionMoveService.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const BEDTIME_CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const MONTESSORI_CATEGORY_ID = "10000000-0000-4000-8000-000000000004";
const TARGET_EDITION = 721;
const resourceId = randomUUID();
const coverId = randomUUID();
let prisma: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.presentationCategory.update({
    where: { id: MONTESSORI_CATEGORY_ID },
    data: { nextEditionNumber: TARGET_EDITION },
  });
  await prisma.resource.create({
    data: { id: resourceId, name: "Guide cover collection move contract" },
  });
  await prisma.resourcePresentation.create({
    data: { resourceId, categoryId: BEDTIME_CATEGORY_ID, editionNumber: 712 },
  });
  await prisma.resourceCoverVersion.create({
    data: {
      id: coverId,
      resourceId,
      revision: 1,
      status: "published",
      renderStatus: "ready",
      categoryId: BEDTIME_CATEGORY_ID,
      editionNumber: 712,
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "bedtime_blush_v1",
      illustrationKey: "bedtime_window_house_v1",
      kicker: "A TINY WIN FOR TONIGHT",
      collectionLabel: "SLEEP",
      headline: "Bedtime can feel softer",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Prepared for calmer evenings.",
      alternativeDescription: "A TinySoho bedtime guide cover.",
      contentHash: "9".repeat(64),
      dmStoragePath: `guide-cover/${resourceId}/${coverId}/${"9".repeat(64)}/dm.png`,
      approvedBy: "contract-test",
      approvedAt: new Date(),
      publishedBy: "contract-test",
      publishedAt: new Date(),
    },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await prisma.guideCoverOrphan.deleteMany({ where: { resourceId } });
  await prisma.resourceCoverVersion.deleteMany({ where: { resourceId } });
  await prisma.resourcePresentation.deleteMany({ where: { resourceId } });
  await prisma.resource.deleteMany({ where: { id: resourceId } });
  await prisma.presentationCategory.update({
    where: { id: MONTESSORI_CATEGORY_ID },
    data: { nextEditionNumber: 1 },
  });
  await prisma.$disconnect();
});

describeWithDatabase("guide cover collection move PostgreSQL behavior", () => {
  it("allocates the target edition once and keeps the historical snapshot", async () => {
    const service = createGuideCoverCollectionMoveService({ database: prisma });
    const input = {
      actorId: "contract-test",
      resourceId,
      expectedCategoryId: BEDTIME_CATEGORY_ID,
      targetCategoryId: MONTESSORI_CATEGORY_ID,
      expectedPublishedCoverId: coverId,
      expectedPublishedCoverRevision: 1,
    };

    const results = await Promise.all([service.move(input), service.move(input)]);
    expect(results.filter((result) => result.ok && result.outcome === "moved")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.outcome === "replayed")).toHaveLength(1);

    await expect(
      prisma.resourcePresentation.findUnique({ where: { resourceId } }),
    ).resolves.toMatchObject({
      categoryId: MONTESSORI_CATEGORY_ID,
      editionNumber: TARGET_EDITION,
    });
    await expect(
      prisma.presentationCategory.findUnique({ where: { id: MONTESSORI_CATEGORY_ID } }),
    ).resolves.toMatchObject({ nextEditionNumber: TARGET_EDITION + 1 });
    await expect(
      prisma.resourceCoverVersion.findUnique({ where: { id: coverId } }),
    ).resolves.toMatchObject({
      categoryId: BEDTIME_CATEGORY_ID,
      editionNumber: 712,
      status: "retired",
    });
  });
});
