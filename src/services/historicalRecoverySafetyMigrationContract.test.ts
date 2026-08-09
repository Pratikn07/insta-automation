import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
const ids = {
  resource: randomUUID(),
  keyword: randomUUID(),
  user: `p1-safety-${randomUUID()}`,
  conversation: randomUUID(),
  intent: randomUUID(),
  campaign: randomUUID(),
};

async function expectSqlState(operation: Promise<unknown>, sqlState: string): Promise<void> {
  try {
    await operation;
    throw new Error(`expected PostgreSQL SQLSTATE ${sqlState}`);
  } catch (error) {
    expect(error).toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({ code: sqlState }),
    });
  }
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await prisma.resource.create({ data: { id: ids.resource, name: "P1 safety contract" } });
  await prisma.keyword.create({
    data: {
      id: ids.keyword,
      keyword: `p1-safety-${ids.keyword}`,
      resourceId: ids.resource,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await prisma.igUser.create({ data: { id: ids.user } });
  await prisma.conversation.create({
    data: { id: ids.conversation, igUserId: ids.user, keywordId: ids.keyword },
  });
  const now = new Date();
  await prisma.journeyIntent.create({
    data: {
      id: ids.intent,
      igUserId: ids.user,
      keywordId: ids.keyword,
      canonicalConversationId: ids.conversation,
      windowStartedAt: now,
      lastTriggerAt: now,
      windowExpiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  await prisma.recoveryCampaign.create({
    data: {
      id: ids.campaign,
      phase: "unknown_read_pilot",
      selectionVersion: `p1-safety-${randomUUID()}`,
      sourceDataCutoff: now,
      copyVersion: "v1",
      decisionHash: "p1-safety-contract",
      candidateCount: 1,
    },
  });
  await prisma.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
});

afterAll(async () => {
  if (!prisma) return;
  const [{ health_table: healthTable, batch_table: batchTable }] = await prisma.$queryRaw<
    Array<{ health_table: string | null; batch_table: string | null }>
  >`
    SELECT
      to_regclass('public.recovery_campaign_health_observation')::text AS health_table,
      to_regclass('public.recovery_campaign_batch_run')::text AS batch_table
  `;
  if (healthTable) {
    await prisma.$executeRaw`
      DELETE FROM "recovery_campaign_health_observation"
      WHERE "campaign_id" = ${ids.campaign}::uuid
    `;
  }
  if (batchTable) {
    await prisma.$executeRaw`
      DELETE FROM "recovery_campaign_batch_run"
      WHERE "campaign_id" = ${ids.campaign}::uuid
    `;
  }
  await prisma.recoveryCampaign.deleteMany({ where: { id: ids.campaign } });
  await prisma.journeyIntent.deleteMany({ where: { id: ids.intent } });
  await prisma.conversation.deleteMany({ where: { id: ids.conversation } });
  await prisma.igUser.deleteMany({ where: { id: ids.user } });
  await prisma.keyword.deleteMany({ where: { id: ids.keyword } });
  await prisma.resource.deleteMany({ where: { id: ids.resource } });
  await prisma.$disconnect();
});

describeWithDatabase("historical recovery safety migration", () => {
  it("creates the tick lease columns and backend-only safety tables", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dm_recovery_control'
        AND column_name IN ('historical_tick_token', 'historical_tick_expires_at')
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "historical_tick_expires_at",
      "historical_tick_token",
    ]);

    const tables = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; table_name: string }>
    >`
      SELECT c.relrowsecurity, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'recovery_campaign_batch_run',
          'recovery_campaign_health_observation'
        )
      ORDER BY c.relname
    `;
    expect(tables).toEqual([
      { relrowsecurity: true, table_name: "recovery_campaign_batch_run" },
      { relrowsecurity: true, table_name: "recovery_campaign_health_observation" },
    ]);
  });

  it("requires the control lease token and expiry together", async () => {
    await expectSqlState(
      prisma.$executeRaw`
        UPDATE "dm_recovery_control"
        SET "historical_tick_token" = ${randomUUID()}::uuid,
            "historical_tick_expires_at" = NULL
        WHERE "id" = 1
      `,
      "23514",
    );
  });

  it("rejects a batch whose consumption exceeds its allowance", async () => {
    await expectSqlState(
      prisma.$executeRaw`
        INSERT INTO "recovery_campaign_batch_run" (
          "campaign_id", "tick_token", "allowance", "consumed", "status",
          "started_at", "lease_expires_at"
        ) VALUES (
          ${ids.campaign}::uuid, ${randomUUID()}::uuid, 1, 2,
          'active'::"recovery_campaign_batch_status", NOW(), NOW() + INTERVAL '5 minutes'
        )
      `,
      "23514",
    );
  });

  it("deduplicates health evidence by campaign and source key", async () => {
    const sourceKey = `moderation:${randomUUID()}`;
    await prisma.$executeRaw`
      INSERT INTO "recovery_campaign_health_observation" (
        "campaign_id", "kind", "source_key", "observed_at"
      ) VALUES (
        ${ids.campaign}::uuid,
        'complaint'::"recovery_campaign_health_kind",
        ${sourceKey},
        NOW()
      )
    `;

    await expectSqlState(
      prisma.$executeRaw`
        INSERT INTO "recovery_campaign_health_observation" (
          "campaign_id", "kind", "source_key", "observed_at"
        ) VALUES (
          ${ids.campaign}::uuid,
          'complaint'::"recovery_campaign_health_kind",
          ${sourceKey},
          NOW()
        )
      `,
      "23505",
    );
  });

  it("allows only one active batch per campaign", async () => {
    await prisma.$executeRaw`
      INSERT INTO "recovery_campaign_batch_run" (
        "campaign_id", "tick_token", "allowance", "consumed", "status",
        "started_at", "lease_expires_at"
      ) VALUES (
        ${ids.campaign}::uuid, ${randomUUID()}::uuid, 1, 0,
        'active'::"recovery_campaign_batch_status", NOW(), NOW() + INTERVAL '5 minutes'
      )
    `;

    await expectSqlState(
      prisma.$executeRaw`
        INSERT INTO "recovery_campaign_batch_run" (
          "campaign_id", "tick_token", "allowance", "consumed", "status",
          "started_at", "lease_expires_at"
        ) VALUES (
          ${ids.campaign}::uuid, ${randomUUID()}::uuid, 1, 0,
          'active'::"recovery_campaign_batch_status", NOW(), NOW() + INTERVAL '5 minutes'
        )
      `,
      "23505",
    );
  });
});
