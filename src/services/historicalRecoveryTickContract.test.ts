import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let ticks: typeof import("./historicalRecoveryTickRepository.js");
let historical: typeof import("./historicalRecoveryRepository.js");
const prefix = `tick-contract-${randomUUID()}`;
let resourceId: string;
let keywordId: string;

const T0 = new Date("2026-08-08T12:00:00Z");

async function wipe(): Promise<void> {
  await db.publicRecoveryDispatch.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCampaignBatchRun.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: prefix } } },
  });
  await db.recoveryCampaignHealthObservation.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: prefix } } },
  });
  await db.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: prefix } } });
  await db.journeyIntent.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.igUser.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: { historicalTickToken: null, historicalTickExpiresAt: null },
  });
}

async function createCampaign(batchSize: number): Promise<string> {
  const id = randomUUID();
  await db.recoveryCampaign.create({
    data: {
      id,
      phase: "unknown_read_pilot",
      selectionVersion: `${prefix}-${id}`,
      sourceDataCutoff: T0,
      copyVersion: "tick-contract-v1",
      batchSize,
      hourlyCap: 100,
      dailyCap: 100,
      westernOnly: false,
      state: "running",
      approvedBy: "contract",
      approvedAt: T0,
      startedAt: T0,
    },
  });
  return id;
}

async function createCandidate(campaignId: string): Promise<string> {
  const igUserId = `${prefix}-${randomUUID()}`;
  await db.igUser.create({ data: { id: igUserId } });
  const intent = await db.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: T0,
      lastTriggerAt: T0,
      windowExpiresAt: new Date(T0.getTime() + 48 * 3600_000),
    },
  });
  const commentId = `${prefix}-comment-${randomUUID()}`;
  const row = await db.recoveryCandidate.create({
    data: {
      campaignId,
      campaignPhase: "unknown_read_pilot",
      intentId: intent.id,
      igUserId,
      keywordId,
      commentId,
      commentAt: T0,
      keywordSnapshot: "SLEEP",
      publicReplyText: "contract",
      evidence: "gate_sent_no_read",
      arm: "treatment",
      eligibleAt: T0,
      sources: {
        create: {
          position: 0,
          commentId,
          receivedAt: T0,
          choiceReason: "newest_eligible_comment",
        },
      },
    },
  });
  return row.id;
}

async function approvedCommentId(candidateId: string): Promise<string> {
  const source = await db.recoveryCandidateSource.findFirstOrThrow({
    where: { candidateId },
    orderBy: { position: "asc" },
    select: { commentId: true },
  });
  return source.commentId;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  ticks = await import("./historicalRecoveryTickRepository.js");
  historical = await import("./historicalRecoveryRepository.js");
  resourceId = randomUUID();
  keywordId = randomUUID();
  await db.resource.create({ data: { id: resourceId, name: prefix } });
  await db.keyword.create({
    data: {
      id: keywordId,
      keyword: prefix,
      resourceId,
      publicReply: "contract",
      gateMessage: "contract",
    },
  });
});

beforeEach(async () => {
  if (!db) return;
  await wipe();
});

afterAll(async () => {
  if (!db) return;
  await wipe();
  if (keywordId) await db.keyword.deleteMany({ where: { id: keywordId } });
  if (resourceId) await db.resource.deleteMany({ where: { id: resourceId } });
  await db.$disconnect();
});

describeWithDatabase("distributed historical recovery pacing", () => {
  it("grants exactly one tick lease across five concurrent workers", async () => {
    const expiresAt = new Date(T0.getTime() + 5 * 60_000);
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => ticks.acquireHistoricalTick(T0, expiresAt)),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it("allows a replacement at the exact lease-expiry boundary", async () => {
    const firstExpiry = new Date(T0.getTime() + 1_000);
    const first = await ticks.acquireHistoricalTick(T0, firstExpiry);
    expect(first).not.toBeNull();

    const campaignId = await createCampaign(1);
    const batch = await ticks.openCampaignBatch(first!, campaignId, T0);
    expect(batch).not.toBeNull();

    const replacement = await ticks.acquireHistoricalTick(
      firstExpiry,
      new Date(firstExpiry.getTime() + 5 * 60_000),
    );
    expect(replacement).toEqual({ token: expect.any(String), expiresAt: expect.any(Date) });
    expect(replacement?.token).not.toBe(first?.token);
    expect(await db.recoveryCampaignBatchRun.findUnique({ where: { id: batch!.id } }))
      .toMatchObject({ status: "expired", endedAt: firstExpiry });
  });

  it("opens only one active batch for a campaign and tick", async () => {
    const lease = await ticks.acquireHistoricalTick(T0, new Date(T0.getTime() + 5 * 60_000));
    const campaignId = await createCampaign(1);
    const batches = await Promise.all([
      ticks.openCampaignBatch(lease!, campaignId, T0),
      ticks.openCampaignBatch(lease!, campaignId, T0),
    ]);

    expect(batches.filter(Boolean)).toHaveLength(1);
    expect(await db.recoveryCampaignBatchRun.count({
      where: { campaignId, status: "active" },
    })).toBe(1);
  });

  it("gives each running campaign its own approved allowance", async () => {
    const lease = await ticks.acquireHistoricalTick(T0, new Date(T0.getTime() + 5 * 60_000));
    const one = await createCampaign(1);
    const five = await createCampaign(5);

    await expect(ticks.openCampaignBatch(lease!, one, T0)).resolves.toMatchObject({ allowance: 1 });
    await expect(ticks.openCampaignBatch(lease!, five, T0)).resolves.toMatchObject({ allowance: 5 });
  });

  it("allows one dispatch start when five workers consume an allowance of one", async () => {
    const expiresAt = new Date(T0.getTime() + 5 * 60_000);
    const lease = await ticks.acquireHistoricalTick(T0, expiresAt);
    const campaignId = await createCampaign(1);
    const batch = await ticks.openCampaignBatch(lease!, campaignId, T0);
    const candidateIds = await Promise.all(
      Array.from({ length: 5 }, () => createCandidate(campaignId)),
    );
    const claimExpiry = new Date(T0.getTime() + 60_000);
    const claims = await Promise.all(
      candidateIds.map((id) => historical.claimCandidate(id, T0, claimExpiry)),
    );
    const reservations = await Promise.all(
      candidateIds.map((candidateId, index) => historical.reserveHistoricalDispatch({
        candidateId,
        claimToken: claims[index]!.claimToken,
        now: T0,
        hourlyCap: 100,
        dailyCap: 100,
        globalHourlyCap: 100,
        globalDailyCap: 100,
        prospectiveCooldownHours: 24,
      })),
    );
    expect(reservations.every((reservation) => reservation.kind === "reserved")).toBe(true);

    const results = await Promise.all(
      candidateIds.map(async (candidateId, index) => {
        const reservation = reservations[index]!;
        if (reservation.kind !== "reserved") throw new Error("expected reservation");
        return historical.startHistoricalDispatch({
          candidateId,
          commentId: await approvedCommentId(candidateId),
          claimToken: claims[index]!.claimToken,
          batchRunId: batch!.id,
          ...reservation,
          now: new Date(T0.getTime() + 1),
        });
      }),
    );

    expect(results.filter((result) => result.kind === "started")).toHaveLength(1);
    expect(results.filter(
      (result) => result.kind === "blocked" && result.reason === "campaign_batch_exhausted",
    )).toHaveLength(4);
    expect(await db.recoveryCampaignBatchRun.findUnique({ where: { id: batch!.id } }))
      .toMatchObject({ consumed: 1 });
  });
});
