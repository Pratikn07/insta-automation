import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let historical: typeof import("./historicalRecoveryRepository.js");
let prospective: typeof import("./dmRecoveryRepository.js");
const prefix = `dispatch-contract-${randomUUID()}`;
let resourceId: string;
let keywordId: string;

async function createPerson(): Promise<string> {
  const id = `${prefix}-${randomUUID()}`;
  await db.igUser.create({ data: { id } });
  return id;
}

async function createCampaign(): Promise<string> {
  const id = randomUUID();
  await db.recoveryCampaign.create({
    data: {
      id,
      phase: "unknown_read_pilot",
      selectionVersion: `${prefix}-${id}`,
      sourceDataCutoff: new Date(),
      copyVersion: "contract-v1",
      state: "running",
      approvedBy: "contract@example.com",
      approvedAt: new Date(),
    },
  });
  return id;
}

async function createCandidate(igUserId: string, requestedCampaignId?: string) {
  const campaignId = requestedCampaignId ?? await createCampaign();
  const now = new Date();
  const intent = await db.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: now,
      lastTriggerAt: now,
      windowExpiresAt: new Date(now.getTime() + 60_000),
    },
  });
  return db.recoveryCandidate.create({
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
}

async function createReminder(igUserId: string) {
  const conversation = await db.conversation.create({
    data: { igUserId, keywordId, state: "expired" },
  });
  return db.dmRecoveryReminder.create({
    data: {
      conversationId: conversation.id,
      igUserId,
      keywordId,
      keywordSnapshot: "SLEEP",
      templateVersion: "contract-v1",
      publicReplyText: "contract",
      commentId: `${prefix}-prospective-${randomUUID()}`,
      triggerKind: "settings_blocked",
      status: "waiting",
      cohort: "treatment",
      eligibleAt: new Date(Date.now() - 60_000),
    },
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  historical = await import("./historicalRecoveryRepository.js");
  prospective = await import("./dmRecoveryRepository.js");
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

afterEach(async () => {
  if (!db) return;
  await db.publicRecoveryDispatch.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.dmRecoveryReminder.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.conversation.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.journeyIntent.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: prefix } } });
  await db.igUser.deleteMany({ where: { id: { startsWith: prefix } } });
});

afterAll(async () => {
  if (!db) return;
  await db.keyword.deleteMany({ where: { id: keywordId } });
  await db.resource.deleteMany({ where: { id: resourceId } });
  await db.$disconnect();
});

describeWithDatabase("public recovery dispatch concurrency", () => {
  it("does not let a new historical claim overwrite an expired owner", async () => {
    const candidate = await createCandidate(await createPerson());
    const claimedAt = new Date();
    const first = await historical.claimCandidate(
      candidate.id,
      claimedAt,
      new Date(claimedAt.getTime() + 1),
    );
    expect(first).not.toBeNull();

    const replacement = await historical.claimCandidate(
      candidate.id,
      new Date(claimedAt.getTime() + 2),
      new Date(claimedAt.getTime() + 60_000),
    );
    expect(replacement).toBeNull();
    expect((await db.recoveryCandidate.findUnique({ where: { id: candidate.id } }))?.claimToken)
      .toBe(first!.claimToken);
  });

  it("allows only one reservation across two historical campaigns for one person", async () => {
    const person = await createPerson();
    const first = await createCandidate(person);
    const second = await createCandidate(person);
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    const [firstClaim, secondClaim] = await Promise.all([
      historical.claimCandidate(first.id, now, lease),
      historical.claimCandidate(second.id, now, lease),
    ]);
    expect(firstClaim).not.toBeNull();
    expect(secondClaim).not.toBeNull();

    const results = await Promise.all([
      historical.reserveHistoricalDispatch({
        candidateId: first.id,
        claimToken: firstClaim!.claimToken,
        now,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      }),
      historical.reserveHistoricalDispatch({
        candidateId: second.id,
        claimToken: secondClaim!.claimToken,
        now,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      }),
    ]);

    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(await db.publicRecoveryDispatch.count({
      where: { igUserId: person, state: { in: ["reserved", "dispatch_started"] } },
    })).toBe(1);
  });

  it("allows one winner when prospective and historical reserve the same person", async () => {
    const person = await createPerson();
    const candidate = await createCandidate(person);
    const reminder = await createReminder(person);
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    const [candidateClaim, reminderClaim] = await Promise.all([
      historical.claimCandidate(candidate.id, now, lease),
      prospective.claimRecovery(reminder.id, now, lease),
    ]);
    expect(candidateClaim).not.toBeNull();
    expect(reminderClaim).not.toBeNull();

    const [historicalResult, prospectiveResult] = await Promise.all([
      historical.reserveHistoricalDispatch({
        candidateId: candidate.id,
        claimToken: candidateClaim!.claimToken,
        now,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      }),
      prospective.authorizeClaimForSend(reminder.id, reminderClaim!.claimToken, now),
    ]);
    const prospectiveWon =
      prospectiveResult.kind === "send_settings_fallback" ||
      prospectiveResult.kind === "send_no_confirmed_read_reminder";
    expect(Number(historicalResult.kind === "reserved") + Number(prospectiveWon)).toBe(1);
    expect(await db.publicRecoveryDispatch.count({
      where: { igUserId: person, state: { in: ["reserved", "dispatch_started"] } },
    })).toBe(1);
  });

  it("rejects stale claim and reservation tokens at every dispatch boundary", async () => {
    const candidate = await createCandidate(await createPerson());
    const now = new Date();
    const claim = await historical.claimCandidate(
      candidate.id,
      now,
      new Date(now.getTime() + 60_000),
    );
    expect(claim).not.toBeNull();
    await expect(historical.reserveHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: randomUUID(),
      now,
      hourlyCap: 10,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    })).resolves.toEqual({ kind: "blocked", reason: "stale_claim" });

    const reservation = await historical.reserveHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: claim!.claimToken,
      now,
      hourlyCap: 10,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    });
    if (reservation.kind !== "reserved") throw new Error("expected reservation");
    await expect(historical.startHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: claim!.claimToken,
      dispatchId: reservation.dispatchId,
      reservationToken: randomUUID(),
      now,
    })).resolves.toBe(false);
    await expect(historical.startHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: claim!.claimToken,
      ...reservation,
      now,
    })).resolves.toBe(true);
    await expect(historical.finalizeHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: claim!.claimToken,
      dispatchId: reservation.dispatchId,
      reservationToken: randomUUID(),
      outcome: { kind: "uncertain", reason: "contract" },
    })).resolves.toBe(false);
  });

  it("releases expired pre-network work and never retries expired started work", async () => {
    const preNetwork = await createCandidate(await createPerson());
    const started = await createCandidate(await createPerson());
    const claimedAt = new Date();
    const lease = new Date(claimedAt.getTime() + 1_000);
    const [preClaim, startedClaim] = await Promise.all([
      historical.claimCandidate(preNetwork.id, claimedAt, lease),
      historical.claimCandidate(started.id, claimedAt, lease),
    ]);
    const reservations = await Promise.all([
      historical.reserveHistoricalDispatch({
        candidateId: preNetwork.id,
        claimToken: preClaim!.claimToken,
        now: claimedAt,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      }),
      historical.reserveHistoricalDispatch({
        candidateId: started.id,
        claimToken: startedClaim!.claimToken,
        now: claimedAt,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      }),
    ]);
    if (reservations[1]!.kind !== "reserved") throw new Error("expected reservation");
    await historical.startHistoricalDispatch({
      candidateId: started.id,
      claimToken: startedClaim!.claimToken,
      ...reservations[1],
      now: claimedAt,
    });

    await expect(historical.reconcileExpiredCandidateLeases(
      new Date(lease.getTime() + 1),
    )).resolves.toEqual({ released: 1, uncertain: 1 });
    expect((await db.recoveryCandidate.findUnique({ where: { id: preNetwork.id } }))?.outcome)
      .toBe("pending");
    expect((await db.recoveryCandidate.findUnique({ where: { id: started.id } }))?.outcome)
      .toBe("send_uncertain");
    expect(await db.publicRecoveryDispatch.groupBy({
      by: ["state"],
      where: { sourceId: { in: [preNetwork.id, started.id] } },
      _count: true,
      orderBy: { state: "asc" },
    })).toEqual([
      { state: "uncertain", _count: 1 },
      { state: "released", _count: 1 },
    ]);
  });

  it("counts historical ledger attempts against prospective global capacity", async () => {
    const capacityPerson = await createPerson();
    const campaignId = await createCampaign();
    const now = new Date();
    await db.publicRecoveryDispatch.createMany({
      data: Array.from({ length: 30 }, () => ({
        reservationToken: randomUUID(),
        igUserId: capacityPerson,
        sourceKind: "historical" as const,
        sourceId: randomUUID(),
        attemptNumber: 1,
        campaignId,
        state: "sent" as const,
        reservedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        dispatchStartedAt: now,
        sentAt: now,
        providerReplyId: `provider-${randomUUID()}`,
      })),
    });
    const target = await createPerson();
    const reminder = await createReminder(target);
    const claim = await prospective.claimRecovery(
      reminder.id,
      now,
      new Date(now.getTime() + 60_000),
    );
    expect(claim).not.toBeNull();
    await expect(
      prospective.authorizeClaimForSend(reminder.id, claim!.claimToken, now),
    ).resolves.toEqual({ kind: "pause", reason: "hourly_cap" });
  });
});
