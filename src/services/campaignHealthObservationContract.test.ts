import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let observations: typeof import("./campaignHealthObservation.js");
let campaignControl: typeof import("./recoveryCampaignControl.js");
const prefix = `health-observation-${randomUUID()}`;
const igUserId = `${prefix}-person`;

async function wipe(): Promise<void> {
  await db.dmMessage.deleteMany({ where: { thread: { igUserId } } });
  await db.dmThread.deleteMany({ where: { igUserId } });
  await db.publicRecoveryDispatch.deleteMany({ where: { igUserId } });
  await db.recoveryCampaignHealthObservation.deleteMany({
    where: { campaign: { selectionVersion: { startsWith: prefix } } },
  });
  await db.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: prefix } } });
}

async function pendingInbound(text: string, mid: string, observedAt: Date): Promise<string> {
  const thread = await db.dmThread.upsert({
    where: { igAccountId_igUserId: { igAccountId: "contract-account", igUserId } },
    create: {
      igAccountId: "contract-account",
      igUserId,
      lastMessageAt: observedAt,
      lastInboundAt: observedAt,
    },
    update: {},
  });
  const message = await db.dmMessage.create({
    data: {
      threadId: thread.id,
      instagramMessageId: mid,
      direction: "inbound",
      type: "text",
      source: "instagram_user",
      text,
      instagramTimestamp: observedAt,
    },
  });
  return message.id;
}

async function campaign(rolloutGroupId?: string): Promise<string> {
  const row = await db.recoveryCampaign.create({
    data: {
      phase: "unknown_read_pilot",
      selectionVersion: `${prefix}-${randomUUID()}`,
      sourceDataCutoff: new Date("2026-08-08T20:00:00Z"),
      copyVersion: "health-contract-v1",
      state: "running",
      approvedBy: "contract",
      approvedAt: new Date("2026-08-08T20:00:00Z"),
      ...(rolloutGroupId ? { rolloutGroupId, rolloutGroupHourlyCap: 10 } : {}),
    },
  });
  return row.id;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  observations = await import("./campaignHealthObservation.js");
  campaignControl = await import("./recoveryCampaignControl.js");
  await db.igUser.create({ data: { id: igUserId } });
});

beforeEach(async () => {
  if (!db) return;
  await wipe();
});

afterAll(async () => {
  if (!db) return;
  await wipe();
  await db.igUser.deleteMany({ where: { id: igUserId } });
  await db.$disconnect();
});

describeWithDatabase("campaign health observations", () => {
  it.each([
    "complaint",
    "opt_out",
    "block",
    "negative_reply",
    "classifier_anomaly",
  ] as const)("pauses every running group sibling for a direct %s signal", async (kind) => {
    const rolloutGroupId = randomUUID();
    const targetId = await campaign(rolloutGroupId);
    const siblingId = await campaign(rolloutGroupId);
    const unrelatedId = await campaign(randomUUID());
    const input = {
      campaignId: targetId,
      kind,
      sourceKey: `group:${kind}:${randomUUID()}`,
      observedAt: new Date("2026-08-08T20:00:00Z"),
    };

    await expect(observations.recordCampaignHealthObservation(input)).resolves.toEqual({
      created: true,
    });
    await expect(observations.recordCampaignHealthObservation(input)).resolves.toEqual({
      created: false,
    });

    expect(await db.recoveryCampaign.findMany({
      where: { id: { in: [targetId, siblingId] } },
      select: { id: true, state: true, pauseReason: true },
      orderBy: { id: "asc" },
    })).toEqual(
      [targetId, siblingId]
        .sort()
        .map((id) => ({ id, state: "paused", pauseReason: `auto:${kind}` })),
    );
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: unrelatedId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "running", pauseReason: null });
    const groupAudits = (await db.eventLog.findMany({
      where: { kind: "historical_campaign_group_paused" },
      select: { payload: true },
    })).filter((event) => (
      event.payload as { rolloutGroupId?: string }
    ).rolloutGroupId === rolloutGroupId);
    expect(groupAudits).toEqual([{
      payload: {
        rolloutGroupId,
        reason: `auto:${kind}`,
        pausedCampaignIds: [targetId, siblingId].sort(),
        skipped: [],
      },
    }]);
  });

  it("writes one durable group audit for each successful owner invocation", async () => {
    const rolloutGroupId = randomUUID();
    const targetId = await campaign(rolloutGroupId);
    const siblingId = await campaign(rolloutGroupId);

    await campaignControl.pauseCampaignGroup(rolloutGroupId, "owner stop");
    await campaignControl.pauseCampaignGroup(rolloutGroupId, "owner stop");

    const payloads = (await db.eventLog.findMany({
      where: { kind: "historical_campaign_group_paused" },
      select: { payload: true },
      orderBy: { createdAt: "asc" },
    }))
      .map((event) => event.payload as {
        rolloutGroupId?: string;
        pausedCampaignIds?: string[];
        skipped?: Array<{ campaignId: string; state: string }>;
      })
      .filter((payload) => payload.rolloutGroupId === rolloutGroupId);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ pausedCampaignIds: [targetId, siblingId].sort(), skipped: [] });
    expect(payloads[1]).toMatchObject({
      pausedCampaignIds: [],
      skipped: [targetId, siblingId]
        .sort()
        .map((campaignId) => ({ campaignId, state: "paused" })),
    });
  });

  it("rejects an unknown group without a durable audit", async () => {
    const rolloutGroupId = randomUUID();

    await expect(
      campaignControl.pauseCampaignGroup(rolloutGroupId, "owner stop"),
    ).rejects.toMatchObject({ code: "campaign_group_not_found" });

    const audit = (await db.eventLog.findMany({
      where: { kind: "historical_campaign_group_paused" },
      select: { payload: true },
    })).find((event) => (
      event.payload as { rolloutGroupId?: string }
    ).rolloutGroupId === rolloutGroupId);
    expect(audit).toBeUndefined();
  });

  it("creates one append-only observation for a replayed source key", async () => {
    const campaignId = await campaign();
    const input = {
      campaignId,
      kind: "complaint" as const,
      sourceKey: "moderation:case-123",
      observedAt: new Date("2026-08-08T20:00:00Z"),
      safeDetail: "verified_report",
    };

    await expect(observations.recordCampaignHealthObservation(input)).resolves.toEqual({
      created: true,
    });
    await expect(observations.recordCampaignHealthObservation(input)).resolves.toEqual({
      created: false,
    });
    expect(await db.recoveryCampaignHealthObservation.count({ where: { campaignId } })).toBe(1);
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "paused", pauseReason: "auto:complaint" });
  });

  it("never stores inbound message text as observation detail", async () => {
    const campaignId = await campaign();
    await observations.recordCampaignHealthObservation({
      campaignId,
      kind: "opt_out",
      sourceKey: "inbound:mid-123",
      observedAt: new Date("2026-08-08T20:00:00Z"),
    });

    expect(await db.recoveryCampaignHealthObservation.findFirst({ where: { campaignId } }))
      .toMatchObject({ sourceKey: "inbound:mid-123", safeDetail: null });
  });

  it("promotes an exact opt-out only to recently contacted historical campaigns", async () => {
    const campaignId = await campaign();
    const observedAt = new Date("2026-08-08T20:00:00Z");
    const sentAt = new Date(observedAt.getTime() - 60 * 60_000);
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId,
        sourceKind: "historical",
        sourceId: randomUUID(),
        attemptNumber: 1,
        campaignId,
        state: "sent",
        reservedAt: sentAt,
        leaseExpiresAt: new Date(sentAt.getTime() + 60_000),
        dispatchStartedAt: sentAt,
        sentAt,
        providerReplyId: `provider-${randomUUID()}`,
      },
    });

    const input = {
      igUserId,
      instagramMessageId: "mid-opt-out-1",
      text: "STOP",
      observedAt,
    };
    await expect(observations.recordInboundCampaignHealthSignals(input)).resolves.toEqual({
      recorded: 1,
    });
    await expect(observations.recordInboundCampaignHealthSignals(input)).resolves.toEqual({
      recorded: 0,
    });
    expect(await db.recoveryCampaignHealthObservation.findFirst({ where: { campaignId } }))
      .toMatchObject({ kind: "opt_out", sourceKey: "inbound:mid-opt-out-1", safeDetail: null });
  });

  it("treats a dispatch-started historical attempt as safety-relevant", async () => {
    const campaignId = await campaign();
    const observedAt = new Date("2026-08-08T20:00:00Z");
    const startedAt = new Date(observedAt.getTime() - 1_000);
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId,
        sourceKind: "historical",
        sourceId: randomUUID(),
        attemptNumber: 1,
        campaignId,
        state: "dispatch_started",
        reservedAt: startedAt,
        leaseExpiresAt: new Date(observedAt.getTime() + 60_000),
        dispatchStartedAt: startedAt,
      },
    });

    await expect(observations.recordInboundCampaignHealthSignals({
      igUserId,
      instagramMessageId: `mid-in-flight-${randomUUID()}`,
      text: "STOP",
      observedAt,
    })).resolves.toEqual({ recorded: 1 });
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "paused", pauseReason: "auto:opt_out" });
  });

  it("attributes an inbound safety signal to a reserved historical attempt", async () => {
    const campaignId = await campaign();
    const observedAt = new Date("2026-08-08T20:00:00Z");
    const reservedAt = new Date(observedAt.getTime() - 1_000);
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId,
        sourceKind: "historical",
        sourceId: randomUUID(),
        attemptNumber: 1,
        campaignId,
        state: "reserved",
        reservedAt,
        leaseExpiresAt: new Date(observedAt.getTime() + 60_000),
      },
    });

    await expect(observations.recordInboundCampaignHealthSignals({
      igUserId,
      instagramMessageId: `mid-reserved-${randomUUID()}`,
      text: "STOP",
      observedAt,
    })).resolves.toEqual({ recorded: 1 });
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "paused", pauseReason: "auto:opt_out" });
  });

  it("does not create evidence from a message that only contains an opt-out substring", async () => {
    await expect(observations.recordInboundCampaignHealthSignals({
      igUserId,
      instagramMessageId: "mid-benign-1",
      text: "please stop by tomorrow",
      observedAt: new Date("2026-08-08T20:00:00Z"),
    })).resolves.toEqual({ recorded: 0 });
    expect(await db.recoveryCampaignHealthObservation.count()).toBe(0);
  });

  it("reconciles a durable pending inbound before historical dispatch can continue", async () => {
    const campaignId = await campaign();
    const observedAt = new Date("2026-08-08T20:00:00Z");
    const sentAt = new Date(observedAt.getTime() - 60 * 60_000);
    await db.publicRecoveryDispatch.create({
      data: {
        reservationToken: randomUUID(),
        igUserId,
        sourceKind: "historical",
        sourceId: randomUUID(),
        attemptNumber: 1,
        campaignId,
        state: "sent",
        reservedAt: sentAt,
        leaseExpiresAt: new Date(sentAt.getTime() + 60_000),
        dispatchStartedAt: sentAt,
        sentAt,
        providerReplyId: `provider-${randomUUID()}`,
      },
    });
    const messageId = await pendingInbound("STOP", `mid-pending-${randomUUID()}`, observedAt);

    await expect(
      observations.reconcilePendingInboundCampaignHealthSignals(observedAt, 100),
    ).resolves.toEqual({ processed: 1, failed: 0, remaining: false });

    expect(
      await db.dmMessage.findUnique({
        where: { id: messageId },
        select: { campaignHealthCapturedAt: true },
      }),
    ).toEqual({ campaignHealthCapturedAt: observedAt });
    expect(
      await db.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true, pauseReason: true },
      }),
    ).toEqual({ state: "paused", pauseReason: "auto:opt_out" });
  });

  it("reports a backoff-delayed capture as still pending", async () => {
    const now = new Date("2026-08-08T20:00:00Z");
    const messageId = await pendingInbound("STOP", `mid-backoff-${randomUUID()}`, now);
    await db.dmMessage.update({
      where: { id: messageId },
      data: { campaignHealthNextAttemptAt: new Date(now.getTime() + 60_000) },
    });

    await expect(
      observations.reconcilePendingInboundCampaignHealthSignals(now, 100),
    ).resolves.toEqual({ processed: 0, failed: 0, remaining: true });
  });
});
