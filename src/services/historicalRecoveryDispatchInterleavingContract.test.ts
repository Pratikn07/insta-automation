import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let historical: typeof import("./historicalRecoveryRepository.js");
let campaigns: typeof import("./recoveryCampaignControl.js");
const prefix = `dispatch-interleaving-${randomUUID()}`;
const resourceId = randomUUID();
const keywordId = randomUUID();

type ReservedScenario = {
  campaignId: string;
  candidateId: string;
  claimToken: string;
  dispatchId: string;
  reservationToken: string;
  now: Date;
  lease: Date;
};

async function reserveScenario(): Promise<ReservedScenario> {
  const campaignId = randomUUID();
  const igUserId = `${prefix}-${randomUUID()}`;
  const now = new Date();
  const lease = new Date(now.getTime() + 60_000);
  await db.igUser.create({ data: { id: igUserId } });
  const intent = await db.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: now,
      lastTriggerAt: now,
      windowExpiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  await db.recoveryCampaign.create({
    data: {
      id: campaignId,
      phase: "unknown_read_pilot",
      selectionVersion: `${prefix}-${campaignId}`,
      sourceDataCutoff: now,
      copyVersion: "contract-v1",
      decisionHash: `hash-${campaignId}`,
      candidateCount: 1,
      state: "running",
      approvedBy: "contract@example.com",
      approvedAt: now,
      startedAt: now,
    },
  });
  const candidate = await db.recoveryCandidate.create({
    data: {
      campaignId,
      campaignPhase: "unknown_read_pilot",
      intentId: intent.id,
      igUserId,
      keywordId,
      commentId: `${prefix}-comment-${randomUUID()}`,
      commentAt: now,
      keywordSnapshot: "SLEEP",
      publicReplyText: "contract",
      evidence: "gate_sent_no_read",
      arm: "treatment",
      eligibleAt: now,
    },
  });
  const claim = await historical.claimCandidate(candidate.id, now, lease);
  if (!claim) throw new Error("expected candidate claim");
  const reservation = await historical.reserveHistoricalDispatch({
    candidateId: candidate.id,
    claimToken: claim.claimToken,
    now,
    hourlyCap: 100,
    dailyCap: 100,
    globalHourlyCap: 100,
    prospectiveCooldownHours: 24,
  });
  if (reservation.kind !== "reserved") throw new Error(`reservation blocked: ${reservation.reason}`);
  return {
    campaignId,
    candidateId: candidate.id,
    claimToken: claim.claimToken,
    dispatchId: reservation.dispatchId,
    reservationToken: reservation.reservationToken,
    now,
    lease,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  historical = await import("./historicalRecoveryRepository.js");
  campaigns = await import("./recoveryCampaignControl.js");
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

afterEach(async () => {
  if (!db) return;
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
    update: { circuitOpen: false, reason: null, openedAt: null },
  });
});

afterAll(async () => {
  if (!db) return;
  await db.keyword.deleteMany({ where: { id: keywordId } });
  await db.resource.deleteMany({ where: { id: resourceId } });
  await db.$disconnect();
});

describeWithDatabase("historical dispatch state interleavings", () => {
  it("blocks dispatch start when pause commits after reservation", async () => {
    const scenario = await reserveScenario();
    await campaigns.pauseCampaign(scenario.campaignId, "owner pause", scenario.now);

    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({
      kind: "blocked",
      reason: "campaign_not_running",
    });
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "reserved" });

    await expect(
      historical.releaseHistoricalReservation({
        ...scenario,
        at: scenario.now,
        reason: "dispatch_start_rejected:campaign_not_running",
      }),
    ).resolves.toBe(true);
    await expect(
      historical.releaseHistoricalReservation({
        ...scenario,
        at: scenario.now,
        reason: "dispatch_start_rejected:campaign_not_running",
      }),
    ).resolves.toBe(true);
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "released" });
    expect(
      await db.recoveryCandidate.findUnique({
        where: { id: scenario.candidateId },
        select: { outcome: true, claimToken: true },
      }),
    ).toEqual({ outcome: "pending", claimToken: null });
  });

  it("blocks dispatch start when the shared circuit opens after reservation", async () => {
    const scenario = await reserveScenario();
    await db.dmRecoveryControl.update({
      where: { id: 1 },
      data: { circuitOpen: true, reason: "contract", openedAt: scenario.now },
    });

    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({
      kind: "blocked",
      reason: "circuit_open",
    });
  });

  it("cancels and releases work that has not started dispatch", async () => {
    const scenario = await reserveScenario();

    await expect(
      campaigns.cancelCampaign(scenario.campaignId, "owner cancelled", scenario.now),
    ).resolves.toEqual({
      ok: true,
      state: "cancelled",
      cancelledCandidates: 1,
      inFlightCandidates: 0,
    });
    expect(
      await db.recoveryCandidate.findUnique({
        where: { id: scenario.candidateId },
        select: { outcome: true },
      }),
    ).toEqual({ outcome: "cancelled" });
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "released" });
  });

  it("keeps a started dispatch in flight and records Meta success truthfully", async () => {
    const scenario = await reserveScenario();
    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({ kind: "started" });

    await expect(
      campaigns.cancelCampaign(scenario.campaignId, "owner cancelled", scenario.now),
    ).resolves.toEqual({
      ok: true,
      state: "cancelled",
      cancelledCandidates: 0,
      inFlightCandidates: 1,
    });
    await expect(
      historical.finalizeHistoricalDispatch({
        ...scenario,
        outcome: {
          kind: "sent",
          at: new Date(scenario.now.getTime() + 1),
          providerReplyId: `provider-${randomUUID()}`,
        },
      }),
    ).resolves.toBe(true);
    expect(
      await db.recoveryCandidate.findUnique({
        where: { id: scenario.candidateId },
        select: { outcome: true },
      }),
    ).toEqual({ outcome: "sent" });
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "sent" });
  });

  it("reconciles an expired started dispatch after cancellation as uncertain", async () => {
    const scenario = await reserveScenario();
    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({ kind: "started" });
    await campaigns.cancelCampaign(scenario.campaignId, "owner cancelled", scenario.now);

    await expect(
      historical.reconcileExpiredCandidateLeases(new Date(scenario.lease.getTime() + 1)),
    ).resolves.toEqual({ uncertain: 1, released: 0 });
    expect(
      await db.recoveryCandidate.findUnique({
        where: { id: scenario.candidateId },
        select: { outcome: true },
      }),
    ).toEqual({ outcome: "send_uncertain" });
  });
});
