import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Gated on a real Postgres, like the other contract suites. These assertions are
// about constraints the database enforces, so a mocked client would prove nothing.
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

type CampaignFixture = {
  resourceId: string;
  keywordId: string;
  igUserId: string;
  conversationId: string;
  intentId: string;
};

let fixture: CampaignFixture;

const WINDOW_MS = 48 * 60 * 60 * 1000;

async function createFixture(client: PrismaClient): Promise<CampaignFixture> {
  const created: CampaignFixture = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `campaign-contract-user-${randomUUID()}`,
    conversationId: randomUUID(),
    intentId: randomUUID(),
  };

  await client.resource.create({
    data: { id: created.resourceId, name: "Campaign contract resource" },
  });
  await client.keyword.create({
    data: {
      id: created.keywordId,
      keyword: `campaign-contract-${created.keywordId}`,
      resourceId: created.resourceId,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await client.igUser.create({ data: { id: created.igUserId } });
  await client.conversation.create({
    data: {
      id: created.conversationId,
      igUserId: created.igUserId,
      keywordId: created.keywordId,
    },
  });
  const startedAt = new Date();
  await client.journeyIntent.create({
    data: {
      id: created.intentId,
      igUserId: created.igUserId,
      keywordId: created.keywordId,
      canonicalConversationId: created.conversationId,
      windowStartedAt: startedAt,
      lastTriggerAt: startedAt,
      windowExpiresAt: new Date(startedAt.getTime() + WINDOW_MS),
    },
  });

  return created;
}

async function deleteFixture(client: PrismaClient, target: CampaignFixture): Promise<void> {
  await client.recoveryCandidate.deleteMany({ where: { igUserId: target.igUserId } });
  await client.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: "contract-" } } });
  await client.journeyIntent.deleteMany({ where: { igUserId: target.igUserId } });
  await client.conversation.deleteMany({ where: { id: target.conversationId } });
  await client.igUser.deleteMany({ where: { id: target.igUserId } });
  await client.keyword.deleteMany({ where: { id: target.keywordId } });
  await client.resource.deleteMany({ where: { id: target.resourceId } });
}

function campaignData(overrides: Record<string, unknown> = {}) {
  return {
    phase: "unknown_read_pilot" as const,
    selectionVersion: `contract-${randomUUID()}`,
    sourceDataCutoff: new Date(),
    copyVersion: "v1",
    ...overrides,
  };
}

function candidateData(campaignId: string, overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    // Must agree with the campaign's phase and with `evidence` below: the CHECK
    // constraint and the trigger both enforce that pairing now (QA-03).
    campaignPhase: "unknown_read_pilot" as const,
    intentId: fixture.intentId,
    igUserId: fixture.igUserId,
    conversationId: fixture.conversationId,
    keywordId: fixture.keywordId,
    commentId: `campaign-contract-comment-${randomUUID()}`,
    commentAt: new Date(),
    keywordSnapshot: "SLEEP",
    publicReplyText: "contract copy",
    evidence: "gate_sent_no_read",
    arm: "treatment" as const,
    eligibleAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  fixture = await createFixture(prisma);
});

afterAll(async () => {
  if (!prisma) return;
  if (fixture) await deleteFixture(prisma, fixture);
  await prisma.$disconnect();
});

describeWithLocalDatabase("recovery campaign database contract", () => {
  afterEach(async () => {
    if (!prisma) return;
    await prisma.recoveryCandidate.deleteMany({ where: { igUserId: fixture.igUserId } });
    await prisma.recoveryCampaign.deleteMany({
      where: { selectionVersion: { startsWith: "contract-" } },
    });
  });

  it("creates both tables with snake_case names", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('recovery_campaign', 'recovery_candidate')
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual(["recovery_campaign", "recovery_candidate"]);
  });

  // These rows name people the account is about to comment on publicly. Reachable
  // only through the service role, so RLS is on and no policy exists.
  it("enables RLS on both tables with no permissive policies", async () => {
    const rls = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('recovery_campaign', 'recovery_candidate')
    `;
    expect(rls).toHaveLength(2);
    for (const row of rls) expect(row.relrowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM pg_policies
      WHERE tablename IN ('recovery_campaign', 'recovery_candidate')
    `;
    expect(Number(policies[0]!.count)).toBe(0);
  });

  it("stores campaign and candidate timestamps with a time zone", async () => {
    const cols = await prisma.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE (table_name = 'recovery_campaign' AND column_name IN ('source_data_cutoff', 'approved_at'))
         OR (table_name = 'recovery_candidate' AND column_name IN ('eligible_at', 'sent_at', 'comment_at'))
    `;
    expect(cols).toHaveLength(5);
    for (const col of cols) expect(col.data_type).toBe("timestamp with time zone");
  });

  it("ships a campaign as a draft with conservative caps", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });

    // §39 launch defaults. Not permanent limits, but the safe starting point.
    expect(campaign.state).toBe("draft");
    expect(campaign.batchSize).toBe(1);
    expect(campaign.hourlyCap).toBe(3);
    expect(campaign.dailyCap).toBe(10);
    expect(campaign.holdoutPercent).toBe(50);
  });

  // "Approval freezes selection" (§37) has to be enforceable, not merely intended.
  it("refuses to run a campaign that was never approved", async () => {
    await expect(
      prisma.recoveryCampaign.create({ data: campaignData({ state: "running" }) }),
    ).rejects.toThrow();
  });

  it("allows running once approved", async () => {
    const campaign = await prisma.recoveryCampaign.create({
      data: campaignData({ state: "running", approvedBy: "pratik", approvedAt: new Date() }),
    });
    expect(campaign.state).toBe("running");
  });

  // Half an approval record is unusable as an audit trail.
  it("requires the approver and the approval time together", async () => {
    await expect(
      prisma.recoveryCampaign.create({ data: campaignData({ approvedBy: "pratik" }) }),
    ).rejects.toThrow();

    await expect(
      prisma.recoveryCampaign.create({ data: campaignData({ approvedAt: new Date() }) }),
    ).rejects.toThrow();
  });

  it("rejects a holdout percentage outside 0-100", async () => {
    await expect(
      prisma.recoveryCampaign.create({ data: campaignData({ holdoutPercent: 101 }) }),
    ).rejects.toThrow();
  });

  // THE anti-duplicate invariant. The eligible pool measured 608 intents with zero
  // duplicates; this makes a second candidate for one intent impossible rather than
  // merely unobserved.
  it("permits only one candidate per intent within a campaign", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    await expect(
      prisma.recoveryCandidate.create({ data: candidateData(campaign.id) }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  // A person with two eligible keywords must not receive two public comments from
  // one campaign, even though those are two legitimate intents.
  it("permits only one candidate per person within a campaign", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    const secondIntent = await prisma.journeyIntent.create({
      data: {
        igUserId: fixture.igUserId,
        keywordId: fixture.keywordId,
        windowStartedAt: new Date("2026-07-01T00:00:00.000Z"),
        lastTriggerAt: new Date("2026-07-01T00:00:00.000Z"),
        windowExpiresAt: new Date("2026-07-03T00:00:00.000Z"),
      },
    });

    await expect(
      prisma.recoveryCandidate.create({
        data: candidateData(campaign.id, { intentId: secondIntent.id }),
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.journeyIntent.delete({ where: { id: secondIntent.id } });
  });

  // Without the reply id, "sent" is an unverifiable claim — and this feature posts
  // publicly under the account's own name.
  it("refuses to mark a candidate sent without Meta's reply id", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    const candidate = await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    await expect(
      prisma.recoveryCandidate.update({
        where: { id: candidate.id },
        data: { outcome: "sent", sentAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it("accepts a sent candidate carrying its reply id", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    const candidate = await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    const sent = await prisma.recoveryCandidate.update({
      where: { id: candidate.id },
      data: { outcome: "sent", sentAt: new Date(), publicReplyId: "17900000000000000" },
    });

    expect(sent.outcome).toBe("sent");
  });

  // Historical candidates must not enter the prospective experiment (§36): mixing
  // them would corrupt the treatment/control comparison Feature 2 is measuring.
  it("keeps candidates out of the prospective reminder table", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    const reminders = await prisma.dmRecoveryReminder.count({
      where: { igUserId: fixture.igUserId },
    });
    expect(reminders).toBe(0);
  });

  // The intent is the candidate's whole justification for existing, so it must not
  // vanish from underneath an approved campaign.
  it("refuses to delete an intent that a candidate depends on", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });

    await expect(
      prisma.journeyIntent.delete({ where: { id: fixture.intentId } }),
    ).rejects.toThrow();
  });

  it("defaults a new candidate to pending", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    const candidate = await prisma.recoveryCandidate.create({ data: candidateData(campaign.id) });
    expect(candidate.outcome).toBe("pending");
  });

  it("carries the origin snapshot so the filter's decision survives", async () => {
    const campaign = await prisma.recoveryCampaign.create({ data: campaignData() });
    const candidate = await prisma.recoveryCandidate.create({
      data: candidateData(campaign.id, {
        audienceOrigin: "us_western",
        audienceOriginConfidence: "high",
      }),
    });

    expect(candidate.audienceOrigin).toBe("us_western");
    expect(candidate.audienceOriginConfidence).toBe("high");
  });
});
