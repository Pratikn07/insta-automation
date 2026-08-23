import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createGuideCoverPublishService } from "./guideCoverPublishService.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const RECIPES_CATEGORY_ID = "10000000-0000-4000-8000-000000000003";
const resourceId = randomUUID();
const firstCoverId = randomUUID();
const secondCoverId = randomUUID();
const firstHash = "d".repeat(64);
const secondHash = "e".repeat(64);
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const NOW = new Date("2026-08-22T12:00:00.000Z");

let prisma: PrismaClient;

function rendererFor(contentHash: string) {
  return vi.fn(async () => ({
    ok: true as const,
    value: {
      contentHash,
      filename: "dm.png" as const,
      height: 916,
      png,
      pngHash: "f".repeat(64),
      rendition: "dm_cover" as const,
      rendererVersion: "tinysoho-guide-cover-v1" as const,
      svg: "<svg/>",
      width: 1200,
    },
  }));
}

function storageFor(coverVersionId: string, contentHash: string) {
  const path = `guide-cover/${resourceId}/${coverVersionId}/${contentHash}/dm.png`;
  return {
    verifyExact: vi.fn(async () => ({ ok: true as const, exists: true })),
    upload: vi.fn(async () => ({
      ok: true as const,
      value: {
        outcome: "uploaded" as const,
        path,
        publicUrl: `https://cdn.example/${path}`,
      },
    })),
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.presentationCategory.update({
    where: { id: RECIPES_CATEGORY_ID },
    data: { nextEditionNumber: 1 },
  });
  await prisma.resource.create({
    data: { id: resourceId, name: "Guide cover publish contract" },
  });
  await prisma.resourcePresentation.create({
    data: { resourceId, categoryId: RECIPES_CATEGORY_ID },
  });
  await prisma.resourceCoverVersion.create({
    data: {
      id: firstCoverId,
      resourceId,
      revision: 1,
      status: "approved",
      categoryId: RECIPES_CATEGORY_ID,
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "recipes_corner_table_v1",
      illustrationKey: "recipes_corner_bowl_v1",
      kicker: "A LITTLE WIN AT THE TABLE",
      collectionLabel: "RECIPES",
      headline: "Something lovely for lunch",
      supportingLine: "Simple, nourishing food for busy family days.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription: "A TinySoho recipe guide cover.",
      approvedBy: "contract-test",
      approvedAt: NOW,
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
    where: { id: RECIPES_CATEGORY_ID },
    data: { nextEditionNumber: 1 },
  });
  await prisma.$disconnect();
});

describeWithDatabase("guide cover publication PostgreSQL behavior", () => {
  it("publishes once and exactly replays a concurrent first publication", async () => {
    const renderer = rendererFor(firstHash);
    const storage = storageFor(firstCoverId, firstHash);
    const service = createGuideCoverPublishService({
      database: prisma,
      renderer,
      storage,
      now: () => NOW,
    });
    const input = {
      coverVersionId: firstCoverId,
      resourceId,
      expectedRevision: 1,
      actorId: "contract-test",
    };

    const results = await Promise.all([service.publish(input), service.publish(input)]);
    expect(
      results.filter((result) => result.ok && result.outcome === "published"),
      JSON.stringify(results),
    ).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => result.ok && result.outcome === "replayed"),
      JSON.stringify(results),
    ).toHaveLength(
      1,
    );

    await expect(
      prisma.resourcePresentation.findUnique({ where: { resourceId } }),
    ).resolves.toMatchObject({ editionNumber: 1 });
    await expect(
      prisma.presentationCategory.findUnique({ where: { id: RECIPES_CATEGORY_ID } }),
    ).resolves.toMatchObject({ nextEditionNumber: 2 });
    await expect(
      prisma.resourceCoverVersion.count({
        where: { resourceId, status: "published" },
      }),
    ).resolves.toBe(1);
  });

  it("preserves the published cover when replacement upload fails", async () => {
    await prisma.resourceCoverVersion.create({
      data: {
        id: secondCoverId,
        resourceId,
        revision: 2,
        status: "approved",
        categoryId: RECIPES_CATEGORY_ID,
        templateKey: "warm_editorial_corner_v1",
        paletteKey: "recipes_corner_table_v1",
        illustrationKey: "recipes_corner_bowl_v1",
        kicker: "A LITTLE WIN AT THE TABLE",
        collectionLabel: "RECIPES",
        headline: "A second lovely lunch",
        supportingLine: "Simple, nourishing food for busy family days.",
        closingLine: "Made with care by TinySoho.",
        alternativeDescription: "A second TinySoho recipe guide cover.",
        approvedBy: "contract-test",
        approvedAt: NOW,
      },
    });
    const service = createGuideCoverPublishService({
      database: prisma,
      renderer: rendererFor(secondHash),
      storage: {
        verifyExact: vi.fn(async () => ({ ok: true as const, exists: false })),
        upload: vi.fn(async () => ({
          ok: false as const,
          error: "cover_storage_failed" as const,
        })),
      },
      now: () => NOW,
    });

    await expect(
      service.publish({
        coverVersionId: secondCoverId,
        resourceId,
        expectedRevision: 2,
        actorId: "contract-test",
      }),
    ).resolves.toEqual({ ok: false, error: "cover_storage_failed" });
    await expect(
      prisma.resourceCoverVersion.findUnique({ where: { id: firstCoverId } }),
    ).resolves.toMatchObject({ status: "published", contentHash: firstHash });
    await expect(
      prisma.resourceCoverVersion.findUnique({ where: { id: secondCoverId } }),
    ).resolves.toMatchObject({
      status: "approved",
      renderStatus: "rendering",
      contentHash: secondHash,
      dmStoragePath: `guide-cover/${resourceId}/${secondCoverId}/${secondHash}/dm.png`,
    });
  });
});
