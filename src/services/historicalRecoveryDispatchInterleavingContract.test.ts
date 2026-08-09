import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let lockClient: PrismaClient;
let historical: typeof import("./historicalRecoveryRepository.js");
let campaigns: typeof import("./recoveryCampaignControl.js");
let ticks: typeof import("./historicalRecoveryTickRepository.js");
let observations: typeof import("./campaignHealthObservation.js");
let dmThreads: typeof import("./dmThreadService.js");
const prefix = `dispatch-interleaving-${randomUUID()}`;
const resourceId = randomUUID();
const keywordId = randomUUID();

type ReservedScenario = {
  campaignId: string;
  candidateId: string;
  commentId: string;
  igUserId: string;
  claimToken: string;
  batchRunId: string;
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
      sources: {
        create: {
          position: 0,
          commentId: `${prefix}-source-${randomUUID()}`,
          receivedAt: now,
          choiceReason: "newest_eligible_comment",
        },
      },
    },
    include: { sources: true },
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
    globalDailyCap: 100,
    prospectiveCooldownHours: 24,
  });
  if (reservation.kind !== "reserved") throw new Error(`reservation blocked: ${reservation.reason}`);
  const tick = await ticks.acquireHistoricalTick(now, lease);
  if (!tick) throw new Error("expected tick lease");
  const batch = await ticks.openCampaignBatch(tick, campaignId, now);
  if (!batch) throw new Error("expected campaign batch");
  return {
    campaignId,
    candidateId: candidate.id,
    commentId: candidate.sources[0]!.commentId,
    igUserId,
    claimToken: claim.claimToken,
    batchRunId: batch.id,
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
  lockClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  historical = await import("./historicalRecoveryRepository.js");
  campaigns = await import("./recoveryCampaignControl.js");
  ticks = await import("./historicalRecoveryTickRepository.js");
  observations = await import("./campaignHealthObservation.js");
  dmThreads = await import("./dmThreadService.js");
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
  await db.dmMessage.deleteMany({ where: { thread: { igUserId: { startsWith: prefix } } } });
  await db.dmThread.deleteMany({ where: { igUserId: { startsWith: prefix } } });
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
    update: {
      circuitOpen: false,
      reason: null,
      openedAt: null,
      historicalTickToken: null,
      historicalTickExpiresAt: null,
    },
  });
});

afterAll(async () => {
  if (!db) return;
  await db.keyword.deleteMany({ where: { id: keywordId } });
  await db.resource.deleteMany({ where: { id: resourceId } });
  await lockClient.$disconnect();
  await db.$disconnect();
});

describeWithDatabase("historical dispatch state interleavings", () => {
  async function within<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("interleaving timed out")), 3_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function holdControlLock(): Promise<{ release: () => void; done: Promise<void> }> {
    let release!: () => void;
    let acquired!: () => void;
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const acquiredSignal = new Promise<void>((resolve) => { acquired = resolve; });
    const done = lockClient.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
      acquired();
      await releaseSignal;
    });
    await acquiredSignal;
    return { release, done };
  }

  async function waitForBlockedControlQueries(expected: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%dm_recovery_control%'
      `;
      if (Number(row?.n ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${expected} transaction(s) blocked on dm_recovery_control`);
  }

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

  it("authorizes only a source frozen into the owner-reviewed snapshot", async () => {
    const scenario = await reserveScenario();

    await expect(historical.startHistoricalDispatch({
      ...scenario,
      commentId: `${prefix}-unreviewed-${randomUUID()}`,
    })).resolves.toEqual({ kind: "blocked", reason: "source_not_approved" });
    expect(await db.publicRecoveryDispatch.findUnique({
      where: { id: scenario.dispatchId },
      select: { state: true },
    })).toEqual({ state: "reserved" });
    expect(await db.recoveryCandidate.findUnique({
      where: { id: scenario.candidateId },
      select: { dispatchCommentId: true },
    })).toEqual({ dispatchCommentId: null });

    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({ kind: "started" });
    expect(await db.recoveryCandidate.findUnique({
      where: { id: scenario.candidateId },
      select: { dispatchCommentId: true },
    })).toEqual({ dispatchCommentId: scenario.commentId });
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

  it("blocks final dispatch authorization while an inbound health capture is pending", async () => {
    const scenario = await reserveScenario();
    const held = await holdControlLock();
    const inboundPromise = dmThreads.recordInboundMessage({
      igAccountId: "contract-account",
      igUserId: scenario.igUserId,
      instagramMessageId: `pending-${randomUUID()}`,
      text: "STOP",
      messageType: "text",
      mediaUrl: null,
      instagramTimestamp: scenario.now,
    });
    await waitForBlockedControlQueries(1);
    const startPromise = historical.startHistoricalDispatch(scenario);
    await waitForBlockedControlQueries(2);
    held.release();

    const [inbound, start] = await within(Promise.all([inboundPromise, startPromise]));
    await held.done;

    expect(inbound).toMatchObject({ duplicate: false });
    expect(start).toEqual({
      kind: "blocked",
      reason: "campaign_health_capture_pending",
    });
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "reserved" });
  });

  it("blocks final authorization after a new inbound was classified and marked captured", async () => {
    const scenario = await reserveScenario();
    const instagramMessageId = `captured-${randomUUID()}`;
    const inbound = await dmThreads.recordInboundMessage({
      igAccountId: "contract-account",
      igUserId: scenario.igUserId,
      instagramMessageId,
      text: "hello",
      messageType: "text",
      mediaUrl: null,
      instagramTimestamp: scenario.now,
    });
    await expect(observations.recordInboundCampaignHealthSignals({
      igUserId: scenario.igUserId,
      instagramMessageId,
      text: "hello",
      observedAt: scenario.now,
    })).resolves.toEqual({ recorded: 0 });
    await expect(
      observations.markInboundCampaignHealthCaptured(inbound.messageId, scenario.now),
    ).resolves.toBe(true);

    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({
      kind: "blocked",
      reason: "inbound_since_selection",
    });
    expect(
      await db.publicRecoveryDispatch.findUnique({
        where: { id: scenario.dispatchId },
        select: { state: true },
      }),
    ).toEqual({ state: "reserved" });
  });

  it("serializes a durable health stop against final dispatch authorization", async () => {
    const scenario = await reserveScenario();
    const held = await holdControlLock();
    const startPromise = historical.startHistoricalDispatch(scenario);
    await waitForBlockedControlQueries(1);
    const observation = await observations.recordCampaignHealthObservation({
      campaignId: scenario.campaignId,
      kind: "opt_out",
      sourceKey: `interleaving:${randomUUID()}`,
      observedAt: new Date(scenario.now.getTime() + 1),
    });
    held.release();
    const start = await within(startPromise);
    await held.done;

    expect(observation).toEqual({ created: true });
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: scenario.campaignId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "paused", pauseReason: "auto:opt_out" });

    const ledger = await db.publicRecoveryDispatch.findUnique({
      where: { id: scenario.dispatchId },
      select: { state: true },
    });
    expect(start).toEqual({ kind: "blocked", reason: "campaign_not_running" });
    expect(ledger).toEqual({ state: "reserved" });
  });

  it("completes concurrent pause versus dispatch start without deadlock", async () => {
    const scenario = await reserveScenario();
    const held = await holdControlLock();
    const startPromise = historical.startHistoricalDispatch(scenario);
    await waitForBlockedControlQueries(1);
    const pause = await campaigns.pauseCampaign(scenario.campaignId, "owner pause", scenario.now);
    held.release();
    const start = await within(startPromise);
    await held.done;

    expect(pause).toEqual({ ok: true, state: "paused" });
    expect(start).toEqual({ kind: "blocked", reason: "campaign_not_running" });
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: scenario.campaignId },
        select: { state: true },
      }),
    ).toEqual({ state: "paused" });
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

  it("serializes cancellation versus finalization without losing Meta success", async () => {
    const scenario = await reserveScenario();
    await expect(historical.startHistoricalDispatch(scenario)).resolves.toEqual({ kind: "started" });

    const held = await holdControlLock();
    const cancelPromise = campaigns.cancelCampaign(
      scenario.campaignId,
      "owner cancelled",
      scenario.now,
    );
    const finalizePromise = historical.finalizeHistoricalDispatch({
        ...scenario,
        outcome: {
          kind: "sent",
          at: new Date(scenario.now.getTime() + 1),
          providerReplyId: `provider-${randomUUID()}`,
        },
      });
    await waitForBlockedControlQueries(2);
    held.release();
    const [cancel, finalized] = await within(Promise.all([cancelPromise, finalizePromise]));
    await held.done;

    expect(cancel).toMatchObject({ ok: true, state: "cancelled" });
    expect(finalized).toBe(true);
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
