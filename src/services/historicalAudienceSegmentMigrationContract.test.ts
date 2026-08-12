import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let igUserId: string;
let resourceId: string;
let keywordId: string;
let intentId: string;

function campaignData(overrides: Record<string, unknown> = {}) {
  return {
    phase: "unknown_read_pilot" as const,
    selectionVersion: `audience-segment-contract-${randomUUID()}`,
    sourceDataCutoff: new Date(),
    copyVersion: "v1",
    selectionFingerprint: randomUUID(),
    ...overrides,
  };
}

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  igUserId = `audience-segment-contract-user-${randomUUID()}`;
});

afterAll(async () => {
  if (!prisma) return;
  await deleteFixture();
  await prisma.$disconnect();
});

async function deleteFixture(): Promise<void> {
  await prisma.recoveryCandidate.deleteMany({ where: { igUserId } });
  await prisma.recoveryCampaign.deleteMany({
    where: { selectionVersion: { startsWith: "audience-segment-contract-" } },
  });
  if (intentId) await prisma.journeyIntent.deleteMany({ where: { id: intentId } });
  await prisma.igUser.deleteMany({ where: { id: igUserId } });
  if (keywordId) await prisma.keyword.deleteMany({ where: { id: keywordId } });
  if (resourceId) await prisma.resource.deleteMany({ where: { id: resourceId } });
}

describeWithDatabase("historical audience segment migration", () => {
  afterEach(async () => {
    await deleteFixture();
  });

  it("stores the complete nullable historical audience taxonomy", async () => {
    const values = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT enumlabel
      FROM pg_enum
      WHERE enumtypid = 'historical_audience_segment'::regtype
      ORDER BY enumsortorder
    `;
    expect(values.map((value) => value.enumlabel)).toEqual([
      "western",
      "other",
      "unknown_cue",
      "unknown_generic",
      "unknown_no_name",
      "south_asian",
    ]);

    const columns = await prisma.$queryRaw<Array<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      udt_name: string;
    }>>`
      SELECT table_name, column_name, is_nullable, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'audience_segment'
        AND table_name IN ('ig_users', 'recovery_candidate', 'recovery_campaign')
      ORDER BY table_name
    `;
    expect(columns).toEqual([
      { table_name: "ig_users", column_name: "audience_segment", is_nullable: "YES", udt_name: "historical_audience_segment" },
      { table_name: "recovery_campaign", column_name: "audience_segment", is_nullable: "YES", udt_name: "historical_audience_segment" },
      { table_name: "recovery_candidate", column_name: "audience_segment", is_nullable: "YES", udt_name: "historical_audience_segment" },
    ]);
  });

  it("requires rollout group id and hourly cap together within range", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'recovery_campaign'
        AND column_name IN ('rollout_group_id', 'rollout_group_hourly_cap')
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: "rollout_group_hourly_cap", data_type: "integer" },
      { column_name: "rollout_group_id", data_type: "uuid" },
    ]);

    await expect(prisma.recoveryCampaign.create({
      data: campaignData({ rolloutGroupId: randomUUID() }),
    })).rejects.toThrow();
    await expect(prisma.recoveryCampaign.create({
      data: campaignData({ rolloutGroupHourlyCap: 12 }),
    })).rejects.toThrow();
    await expect(prisma.recoveryCampaign.create({
      data: campaignData({ rolloutGroupId: randomUUID(), rolloutGroupHourlyCap: 0 }),
    })).rejects.toThrow();
    await expect(prisma.recoveryCampaign.create({
      data: campaignData({ rolloutGroupId: randomUUID(), rolloutGroupHourlyCap: 1001 }),
    })).rejects.toThrow();

    const campaign = await prisma.recoveryCampaign.create({
      data: campaignData({ rolloutGroupId: randomUUID(), rolloutGroupHourlyCap: 1 }),
    });
    expect(campaign.rolloutGroupHourlyCap).toBe(1);
  });

  it("seals candidate and campaign audience metadata after approval", async () => {
    resourceId = randomUUID();
    keywordId = randomUUID();
    intentId = randomUUID();
    await prisma.igUser.create({ data: { id: igUserId } });
    await prisma.resource.create({ data: { id: resourceId, name: "Audience segment contract resource" } });
    await prisma.keyword.create({
      data: {
        id: keywordId,
        keyword: `audience-segment-contract-${keywordId}`,
        resourceId,
        publicReply: "test",
        gateMessage: "test",
      },
    });
    const startedAt = new Date();
    await prisma.journeyIntent.create({
      data: {
        id: intentId,
        igUserId,
        keywordId,
        windowStartedAt: startedAt,
        lastTriggerAt: startedAt,
        windowExpiresAt: new Date(startedAt.getTime() + 48 * 60 * 60 * 1000),
      },
    });
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    const candidate = await prisma.recoveryCandidate.create({
      data: {
        campaignId: campaign.id,
        campaignPhase: "unknown_read_pilot",
        intentId,
        igUserId,
        keywordId,
        commentId: `audience-segment-contract-comment-${randomUUID()}`,
        commentAt: new Date(),
        keywordSnapshot: "SLEEP",
        publicReplyText: "contract copy",
        evidence: "gate_sent_no_read",
        arm: "treatment",
        eligibleAt: new Date(),
        audienceSegment: "western",
      },
    });
    await prisma.recoveryCampaign.update({
      where: { id: campaign.id },
      data: { state: "running", approvedBy: "contract", approvedAt: new Date() },
    });

    await expect(prisma.recoveryCandidate.update({
      where: { id: candidate.id },
      data: { audienceSegment: "other" },
    })).rejects.toThrow();
    await expect(prisma.recoveryCampaign.update({
      where: { id: campaign.id },
      data: { audienceSegment: "western" },
    })).rejects.toThrow();
    await expect(prisma.recoveryCampaign.update({
      where: { id: campaign.id },
      data: { rolloutGroupId: randomUUID(), rolloutGroupHourlyCap: 1 },
    })).rejects.toThrow();
  });
});
