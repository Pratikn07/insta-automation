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
let otherKeywordId: string;
let intentSequence = 0;

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
  const now = new Date(Date.now() + intentSequence++);
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

async function createReminder(igUserId: string, requestedKeywordId = keywordId) {
  const conversation = await db.conversation.create({
    data: { igUserId, keywordId: requestedKeywordId, state: "expired" },
  });
  return db.dmRecoveryReminder.create({
    data: {
      conversationId: conversation.id,
      igUserId,
      keywordId: requestedKeywordId,
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
  otherKeywordId = randomUUID();
  await db.resource.create({ data: { id: resourceId, name: prefix } });
  await db.keyword.createMany({
    data: [keywordId, otherKeywordId].map((id, index) => ({
      id,
      keyword: `${prefix}-${index}`,
      resourceId,
      publicReply: "contract",
      gateMessage: "contract",
    })),
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
  await db.keyword.deleteMany({ where: { id: { in: [keywordId, otherKeywordId] } } });
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

  it("allows only one reservation across five historical campaigns for one person", async () => {
    const person = await createPerson();
    const candidates = [];
    for (let index = 0; index < 5; index++) {
      candidates.push(await createCandidate(person));
    }
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    const claims = await Promise.all(
      candidates.map((candidate) => historical.claimCandidate(candidate.id, now, lease)),
    );
    expect(claims.every(Boolean)).toBe(true);

    const results = await Promise.all(
      candidates.map((candidate, index) => historical.reserveHistoricalDispatch({
        candidateId: candidate.id,
        claimToken: claims[index]!.claimToken,
        now,
        hourlyCap: 10,
        dailyCap: 10,
        globalHourlyCap: 10,
        prospectiveCooldownHours: 24,
      })),
    );

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

  it("counts prospective ledger attempts against historical global capacity", async () => {
    const capacityPerson = await createPerson();
    const now = new Date();
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: capacityPerson,
        sourceKind: "prospective",
        sourceId: randomUUID(),
        attemptNumber: 1,
        state: "sent",
        reservedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        dispatchStartedAt: now,
        sentAt: now,
        providerReplyId: `provider-${randomUUID()}`,
      },
    });
    const candidate = await createCandidate(await createPerson());
    const claim = await historical.claimCandidate(
      candidate.id,
      now,
      new Date(now.getTime() + 60_000),
    );

    await expect(historical.reserveHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: claim!.claimToken,
      now,
      hourlyCap: 10,
      dailyCap: 10,
      globalHourlyCap: 1,
      prospectiveCooldownHours: 24,
    })).resolves.toEqual({ kind: "blocked", reason: "global_hourly_cap_reached" });
  });

  it("frees released capacity but keeps uncertain capacity consumed", async () => {
    const campaignId = await createCampaign();
    const releasedCandidate = await createCandidate(await createPerson(), campaignId);
    const uncertainCandidate = await createCandidate(await createPerson(), campaignId);
    const nextCandidate = await createCandidate(await createPerson(), campaignId);
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    const [releasedClaim, uncertainClaim, nextClaim] = await Promise.all([
      historical.claimCandidate(releasedCandidate.id, now, lease),
      historical.claimCandidate(uncertainCandidate.id, now, lease),
      historical.claimCandidate(nextCandidate.id, now, lease),
    ]);
    const released = await historical.reserveHistoricalDispatch({
      candidateId: releasedCandidate.id,
      claimToken: releasedClaim!.claimToken,
      now,
      hourlyCap: 1,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    });
    if (released.kind !== "reserved") throw new Error("expected reservation");
    await historical.finalizeHistoricalDispatch({
      candidateId: releasedCandidate.id,
      claimToken: releasedClaim!.claimToken,
      ...released,
      outcome: { kind: "released", reason: "rate_limit", at: now },
    });

    const uncertain = await historical.reserveHistoricalDispatch({
      candidateId: uncertainCandidate.id,
      claimToken: uncertainClaim!.claimToken,
      now,
      hourlyCap: 1,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    });
    expect(uncertain.kind).toBe("reserved");
    if (uncertain.kind !== "reserved") throw new Error("expected reservation");
    await historical.startHistoricalDispatch({
      candidateId: uncertainCandidate.id,
      claimToken: uncertainClaim!.claimToken,
      ...uncertain,
      now,
    });
    await historical.finalizeHistoricalDispatch({
      candidateId: uncertainCandidate.id,
      claimToken: uncertainClaim!.claimToken,
      ...uncertain,
      outcome: { kind: "uncertain", reason: "timeout" },
    });

    await expect(historical.reserveHistoricalDispatch({
      candidateId: nextCandidate.id,
      claimToken: nextClaim!.claimToken,
      now,
      hourlyCap: 1,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    })).resolves.toEqual({ kind: "blocked", reason: "hourly_cap_reached" });
  });

  it("treats exact 24-hour and 30-day cooldown boundaries as eligible", async () => {
    const now = new Date();
    const prospectivePerson = await createPerson();
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: prospectivePerson,
        sourceKind: "prospective",
        sourceId: randomUUID(),
        attemptNumber: 1,
        state: "sent",
        reservedAt: new Date(now.getTime() - 24 * 3600_000),
        leaseExpiresAt: new Date(now.getTime() - 24 * 3600_000 + 60_000),
        dispatchStartedAt: new Date(now.getTime() - 24 * 3600_000),
        sentAt: new Date(now.getTime() - 24 * 3600_000),
        providerReplyId: `provider-${randomUUID()}`,
      },
    });
    const reminder = await createReminder(prospectivePerson, otherKeywordId);
    const reminderClaim = await prospective.claimRecovery(
      reminder.id,
      now,
      new Date(now.getTime() + 60_000),
    );
    const prospectiveDecision = await prospective.authorizeClaimForSend(
      reminder.id,
      reminderClaim!.claimToken,
      now,
    );
    expect([
      "send_settings_fallback",
      "send_no_confirmed_read_reminder",
    ]).toContain(prospectiveDecision.kind);

    const historicalPerson = await createPerson();
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: historicalPerson,
        sourceKind: "prospective",
        sourceId: randomUUID(),
        attemptNumber: 1,
        state: "uncertain",
        reservedAt: new Date(now.getTime() - 30 * 24 * 3600_000),
        leaseExpiresAt: new Date(now.getTime() - 30 * 24 * 3600_000 + 60_000),
        dispatchStartedAt: new Date(now.getTime() - 30 * 24 * 3600_000),
        terminalReason: "timeout",
      },
    });
    const candidate = await createCandidate(historicalPerson);
    const candidateClaim = await historical.claimCandidate(
      candidate.id,
      now,
      new Date(now.getTime() + 60_000),
    );
    await expect(historical.reserveHistoricalDispatch({
      candidateId: candidate.id,
      claimToken: candidateClaim!.claimToken,
      now,
      hourlyCap: 10,
      dailyCap: 10,
      globalHourlyCap: 10,
      prospectiveCooldownHours: 24,
    })).resolves.toMatchObject({ kind: "reserved" });
  });

  it("shares person cooldown across different keywords just inside the boundary", async () => {
    const person = await createPerson();
    const now = new Date();
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId: person,
        sourceKind: "prospective",
        sourceId: randomUUID(),
        attemptNumber: 1,
        state: "sent",
        reservedAt: new Date(now.getTime() - 24 * 3600_000 + 1),
        leaseExpiresAt: new Date(now.getTime() - 24 * 3600_000 + 60_001),
        dispatchStartedAt: new Date(now.getTime() - 24 * 3600_000 + 1),
        sentAt: new Date(now.getTime() - 24 * 3600_000 + 1),
        providerReplyId: `provider-${randomUUID()}`,
      },
    });
    const reminder = await createReminder(person, otherKeywordId);
    const claim = await prospective.claimRecovery(
      reminder.id,
      now,
      new Date(now.getTime() + 60_000),
    );
    expect(claim).toBeNull();
    expect(await db.dmRecoveryReminder.findUnique({ where: { id: reminder.id } }))
      .toMatchObject({ status: "suppressed", suppressionReason: "person_cooldown" });
  });
});
