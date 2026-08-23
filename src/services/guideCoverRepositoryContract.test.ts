import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGuideCoverRepository } from "./guideCoverRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const BEDTIME_CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const POTTY_CATEGORY_ID = "10000000-0000-4000-8000-000000000002";
const copy = {
  kicker: "A TINY WIN FOR TONIGHT",
  collectionLabel: "SLEEP",
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A TinySoho bedtime guide cover.",
};

let prisma: PrismaClient;
let repository: ReturnType<typeof createGuideCoverRepository>;
const resourceId = randomUUID();
const coverId = randomUUID();
const replacementCoverId = randomUUID();
const siblingDraftId = randomUUID();

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repository = createGuideCoverRepository({ database: prisma });
  await prisma.resource.create({
    data: { id: resourceId, name: "Guide cover repository contract" },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await prisma.guideCoverOrphan.deleteMany({ where: { resourceId } });
  await prisma.resourceCoverVersion.deleteMany({ where: { resourceId } });
  await prisma.resourcePresentation.deleteMany({ where: { resourceId } });
  await prisma.resource.deleteMany({ where: { id: resourceId } });
  await prisma.$disconnect();
});

describeWithDatabase("guide cover repository PostgreSQL behavior", () => {
  it("creates and exactly replays one resource presentation", async () => {
    await expect(
      repository.createOrLoadPresentation({
        resourceId,
        categoryId: BEDTIME_CATEGORY_ID,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(
      repository.createOrLoadPresentation({
        resourceId,
        categoryId: BEDTIME_CATEGORY_ID,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(
      repository.createOrLoadPresentation({
        resourceId,
        categoryId: POTTY_CATEGORY_ID,
      }),
    ).resolves.toEqual({ ok: false, error: "cover_create_conflict" });

    await prisma.resourcePresentation.update({
      where: { resourceId },
      data: { editionNumber: 17 },
    });
    await expect(
      repository.createOrLoadPresentation({
        resourceId,
        categoryId: BEDTIME_CATEGORY_ID,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, value: { editionNumber: 17 } });
  });

  it("creates and exactly replays one UUID-owned draft", async () => {
    const input = {
      id: coverId,
      resourceId,
      categoryId: BEDTIME_CATEGORY_ID,
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "bedtime_blush_v1",
      illustrationKey: "bedtime_window_house_v1",
      suggestionId: null,
      copy,
    };
    await expect(repository.createOrLoadDraft(input)).resolves.toMatchObject({
      ok: true,
      replayed: false,
    });
    await expect(repository.createOrLoadDraft(input)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
  });

  it("lets only one concurrent editor win the same revision", async () => {
    const outcomes = await Promise.all([
      repository.saveDraft({
        id: coverId,
        resourceId,
        expectedRevision: 1,
        copy: { ...copy, headline: "A calmer night" },
      }),
      repository.saveDraft({
        id: coverId,
        resourceId,
        expectedRevision: 1,
        copy: { ...copy, headline: "A softer evening" },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, error: "cover_revision_conflict" },
    ]);
  });

  it("excludes drafts, then returns only the complete published rendition", async () => {
    await expect(repository.findPublished(resourceId)).resolves.toBeNull();

    const contentHash = "c".repeat(64);
    await prisma.resourceCoverVersion.update({
      where: { id: coverId },
      data: {
        status: "published",
        renderStatus: "ready",
        editionNumber: 17,
        contentHash,
        dmStoragePath: `guide-cover/${resourceId}/${coverId}/${contentHash}/dm.png`,
        approvedBy: "contract-test",
        approvedAt: new Date(),
        publishedBy: "contract-test",
        publishedAt: new Date(),
      },
    });

    await expect(repository.findPublished(resourceId)).resolves.toMatchObject({
      id: coverId,
      status: "published",
      renderStatus: "ready",
      contentHash,
    });
    await expect(
      repository.saveDraft({
        id: coverId,
        resourceId,
        expectedRevision: 2,
        copy,
      }),
    ).resolves.toEqual({ ok: false, error: "cover_revision_conflict" });
  });

  it("allocates a replacement revision after the first cover is published", async () => {
    await expect(
      repository.createOrLoadDraft({
        id: replacementCoverId,
        resourceId,
        categoryId: BEDTIME_CATEGORY_ID,
        templateKey: "warm_editorial_corner_v1",
        paletteKey: "bedtime_blush_v1",
        illustrationKey: "bedtime_window_house_v1",
        suggestionId: null,
        copy: { ...copy, headline: "A gentler evening" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { id: replacementCoverId, revision: 3, status: "draft" },
    });
  });

  it("saves an older draft at the next free resource revision", async () => {
    await expect(
      repository.createOrLoadDraft({
        id: siblingDraftId,
        resourceId,
        categoryId: BEDTIME_CATEGORY_ID,
        templateKey: "warm_editorial_corner_v1",
        paletteKey: "bedtime_blush_v1",
        illustrationKey: "bedtime_window_house_v1",
        suggestionId: null,
        copy: { ...copy, headline: "A quieter bedtime" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { id: siblingDraftId, revision: 4, status: "draft" },
    });

    await expect(
      repository.saveDraft({
        id: replacementCoverId,
        resourceId,
        expectedRevision: 3,
        copy: { ...copy, headline: "A softer bedtime ritual" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: replacementCoverId, revision: 5, status: "draft" },
    });
    await expect(
      prisma.resourceCoverVersion.findUnique({ where: { id: siblingDraftId } }),
    ).resolves.toMatchObject({ revision: 4 });
  });
});
