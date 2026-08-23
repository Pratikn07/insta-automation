import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resourcesRouter } from "../api/resources.routes.js";
import { createGuideCoverPublishService } from "./guideCoverPublishService.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T12:00:00.000Z");
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
let prisma: PrismaClient;
const createdResourceIds: string[] = [];

function app() {
  const value = express();
  value.use(express.json());
  value.use("/api/resources", resourcesRouter);
  return value;
}

async function createApprovedCover() {
  const resourceId = randomUUID();
  const coverVersionId = randomUUID();
  createdResourceIds.push(resourceId);
  await prisma.resource.create({ data: { id: resourceId, name: "Deletion fence guide" } });
  await prisma.resourcePresentation.create({
    data: { resourceId, categoryId: CATEGORY_ID },
  });
  await prisma.resourceCoverVersion.create({
    data: {
      id: coverVersionId,
      resourceId,
      revision: 1,
      status: "approved",
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
    },
  });
  return { resourceId, coverVersionId };
}

function renderResult(contentHash: string) {
  return {
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
  };
}

beforeAll(() => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await prisma.guideCoverOrphan.deleteMany({
    where: { resourceId: { in: createdResourceIds } },
  });
  await prisma.resourceCoverVersion.deleteMany({
    where: { resourceId: { in: createdResourceIds } },
  });
  await prisma.resourcePresentation.deleteMany({
    where: { resourceId: { in: createdResourceIds } },
  });
  await prisma.resource.deleteMany({ where: { id: { in: createdResourceIds } } });
  await prisma.$disconnect();
});

describeWithDatabase("guide cover publication/resource deletion fence", () => {
  it("lets deletion win during pure rendering and stops before Storage", async () => {
    const { resourceId, coverVersionId } = await createApprovedCover();
    let releaseRender!: () => void;
    const rendering = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderer = vi.fn(async () => {
      await rendering;
      return renderResult("a".repeat(64));
    });
    const upload = vi.fn();
    const service = createGuideCoverPublishService({
      database: prisma,
      renderer,
      storage: {
        verifyExact: vi.fn(async () => ({ ok: true as const, exists: false })),
        upload,
      },
      now: () => NOW,
    });
    const publishing = service.publish({
      actorId: "contract-test",
      coverVersionId,
      expectedRevision: 1,
      resourceId,
    });
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());

    await request(app()).delete(`/api/resources/${resourceId}`).expect(204);
    releaseRender();

    await expect(publishing).resolves.toEqual({
      ok: false,
      error: "cover_publish_conflict",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("lets the durable upload intent win and makes deletion refuse", async () => {
    const { resourceId, coverVersionId } = await createApprovedCover();
    let finishUpload!: () => void;
    const uploading = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const upload = vi.fn(async () => {
      await uploading;
      return { ok: false as const, error: "cover_storage_failed" as const };
    });
    const service = createGuideCoverPublishService({
      database: prisma,
      renderer: vi.fn(async () => renderResult("b".repeat(64))),
      storage: {
        verifyExact: vi.fn(async () => ({ ok: true as const, exists: false })),
        upload,
      },
      now: () => NOW,
    });
    const publishing = service.publish({
      actorId: "contract-test",
      coverVersionId,
      expectedRevision: 1,
      resourceId,
    });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());

    await request(app())
      .delete(`/api/resources/${resourceId}`)
      .expect(409, { error: "resource_cover_publish_in_progress" });
    finishUpload();
    await expect(publishing).resolves.toEqual({
      ok: false,
      error: "cover_storage_failed",
    });
  });
});
