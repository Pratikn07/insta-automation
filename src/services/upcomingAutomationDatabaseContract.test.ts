import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bindUpcomingAutomationToMedia } from "./upcomingAutomationBinding.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let resourceId: string;
const setupIds: string[] = [];
const mediaIds: string[] = [];

function word(prefix = "UPCOMING"): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 16)}`.toUpperCase();
}

async function createSetup(triggerWord: string, status: "waiting" | "needs_attention" = "waiting") {
  const row = await prisma.upcomingAutomation.create({
    data: {
      triggerWord,
      resourceId,
      publicReply: "Sent! Check your DMs.",
      gateMessage: "Follow and reply DONE.",
      active: true,
      status,
      createdBy: "contract@example.com",
      ...(status === "needs_attention" && { errorCode: "contract_attention" }),
    },
  });
  setupIds.push(row.id);
  return row;
}

function contractMedia(mediaId: string, triggerWord: string) {
  mediaIds.push(mediaId);
  return {
    id: mediaId,
    kind: "reel" as const,
    mediaType: "VIDEO",
    mediaProductType: "REELS",
    caption: `Contract caption. Comment ${triggerWord}`,
    thumbnailUrl: null,
    permalink: `https://www.instagram.com/reel/${mediaId}/`,
    timestamp: new Date(Date.now() + 60_000).toISOString(),
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const resource = await prisma.resource.create({
    data: {
      name: `Upcoming contract ${randomUUID()}`,
      messages: { create: { order: 0, type: "text", body: "Contract guide" } },
    },
  });
  resourceId = resource.id;
});

afterEach(async () => {
  if (!prisma) return;
  await prisma.upcomingAutomation.deleteMany({ where: { id: { in: setupIds.splice(0) } } });
  await prisma.keyword.deleteMany({ where: { mediaId: { in: mediaIds.splice(0) } } });
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.resource.delete({ where: { id: resourceId } });
  await prisma.$disconnect();
});

describeWithLocalDatabase("upcoming automation database contract", () => {
  it("enables RLS with no browser-facing policies and indexes both foreign keys", async () => {
    const [rls] = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'upcoming_automations'
    `;
    const policies = await prisma.$queryRaw<Array<{ policyname: string }>>`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'upcoming_automations'
    `;
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'upcoming_automations'
    `;

    expect(rls?.relrowsecurity).toBe(true);
    expect(policies).toEqual([]);
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "upcoming_automations_resource_id_idx",
        "upcoming_automations_keyword_id_idx",
      ]),
    );
  });

  it("reserves one open word and permits reuse after the earlier setup is terminal", async () => {
    const triggerWord = word();
    const first = await createSetup(triggerWord);

    await expect(createSetup(triggerWord, "needs_attention")).rejects.toMatchObject({ code: "P2002" });

    await prisma.upcomingAutomation.update({
      where: { id: first.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    await expect(createSetup(triggerWord)).resolves.toMatchObject({ triggerWord, status: "waiting" });
  });

  it("serializes poll and webhook attempts into one keyword", async () => {
    const triggerWord = word("RACE");
    const setup = await createSetup(triggerWord);
    const media = contractMedia(`race-${randomUUID()}`, triggerWord);

    const results = await Promise.all([
      bindUpcomingAutomationToMedia({ setupId: setup.id, media, source: "worker" }),
      bindUpcomingAutomationToMedia({ setupId: setup.id, media, source: "webhook" }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already_bound", "bound"]);
    expect(await prisma.keyword.count({ where: { mediaId: media.id, keyword: triggerWord } })).toBe(1);
    await expect(prisma.upcomingAutomation.findUnique({ where: { id: setup.id } })).resolves.toMatchObject({
      status: "bound",
      matchedMediaId: media.id,
      keywordId: expect.any(String),
    });
  });

  it("marks a manual attachment conflict without changing the existing keyword", async () => {
    const triggerWord = word("CONFLICT");
    const setup = await createSetup(triggerWord);
    const media = contractMedia(`conflict-${randomUUID()}`, triggerWord);
    const manual = await prisma.keyword.create({
      data: {
        keyword: "OTHERWORD",
        mediaId: media.id,
        resourceId,
        publicReply: "Manual reply",
        gateMessage: "Manual gate",
      },
    });

    await expect(
      bindUpcomingAutomationToMedia({ setupId: setup.id, media, source: "worker" }),
    ).resolves.toEqual({ kind: "needs_attention", errorCode: "media_keyword_conflict" });
    expect(await prisma.keyword.findUnique({ where: { id: manual.id } })).toMatchObject({
      keyword: "OTHERWORD",
      publicReply: "Manual reply",
    });
    expect(await prisma.keyword.count({ where: { mediaId: media.id } })).toBe(1);
  });

  it("rolls keyword creation back when the bound-row update fails", async () => {
    const triggerWord = word("ROLLBACK");
    const setup = await createSetup(triggerWord);
    const media = contractMedia(`rollback-${randomUUID()}`, triggerWord);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION upcoming_contract_reject_bound() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.trigger_word LIKE 'ROLLBACK%' AND NEW.status = 'bound' THEN
          RAISE EXCEPTION 'contract rollback';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER upcoming_contract_reject_bound_trigger
      BEFORE UPDATE ON upcoming_automations
      FOR EACH ROW EXECUTE FUNCTION upcoming_contract_reject_bound()
    `);

    try {
      await expect(
        bindUpcomingAutomationToMedia({ setupId: setup.id, media, source: "worker" }),
      ).rejects.toThrow();
      expect(await prisma.keyword.count({ where: { mediaId: media.id } })).toBe(0);
      await expect(prisma.upcomingAutomation.findUnique({ where: { id: setup.id } })).resolves.toMatchObject({
        status: "waiting",
        keywordId: null,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS upcoming_contract_reject_bound_trigger ON upcoming_automations`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS upcoming_contract_reject_bound()`);
    }
  });
});
