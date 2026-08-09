import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import express, { type Router } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;
let attribution: typeof import("./historicalRecoveryAttribution.js");
let historicalRecoveryRouter: Router;
const prefix = `attribution-contract-${randomUUID()}`;
const T0 = new Date("2026-08-08T12:00:00.000Z");
let resourceId: string;
let keywordId: string;
let otherKeywordId: string;
let intentSequence = 0;

type CampaignOptions = {
  startedAt?: Date;
  inboundWindowHours?: number;
  completionWindowHours?: number;
};

async function createCampaign(options: CampaignOptions = {}): Promise<string> {
  const startedAt = options.startedAt ?? T0;
  const row = await db.recoveryCampaign.create({
    data: {
      phase: "unknown_read_pilot",
      selectionVersion: `${prefix}-${randomUUID()}`,
      sourceDataCutoff: T0,
      copyVersion: "attribution-contract-v1",
      state: "running",
      approvedBy: "contract@example.com",
      approvedAt: startedAt,
      startedAt,
      inboundWindowHours: options.inboundWindowHours ?? 24,
      completionWindowHours: options.completionWindowHours ?? 48,
    },
  });
  return row.id;
}

type CandidateOptions = {
  campaignId: string;
  arm: "treatment" | "holdout";
  igUserId?: string;
  keywordId?: string;
  dispatchStartedAt?: Date;
  sentAt?: Date;
  outcome?: "pending" | "sent" | "send_uncertain";
};

async function createCandidate(options: CandidateOptions) {
  const igUserId = options.igUserId ?? `${prefix}-${randomUUID()}`;
  const selectedKeywordId = options.keywordId ?? keywordId;
  await db.igUser.upsert({ where: { id: igUserId }, create: { id: igUserId }, update: {} });
  const windowStartedAt = new Date(T0.getTime() + intentSequence++);
  const intent = await db.journeyIntent.create({
    data: {
      igUserId,
      keywordId: selectedKeywordId,
      windowStartedAt,
      lastTriggerAt: windowStartedAt,
      windowExpiresAt: new Date(windowStartedAt.getTime() + 48 * 3600_000),
    },
  });
  const commentId = `${prefix}-comment-${randomUUID()}`;
  const treatment = options.arm === "treatment";
  const outcome = treatment ? (options.outcome ?? "sent") : "holdout_withheld";
  const sentAt = options.sentAt ?? new Date((options.dispatchStartedAt ?? T0).getTime() + 1_000);
  return db.recoveryCandidate.create({
    data: {
      campaignId: options.campaignId,
      campaignPhase: "unknown_read_pilot",
      intentId: intent.id,
      igUserId,
      keywordId: selectedKeywordId,
      commentId,
      commentAt: T0,
      keywordSnapshot: "SLEEP",
      publicReplyText: "contract",
      evidence: "gate_sent_no_read",
      arm: options.arm,
      outcome,
      eligibleAt: T0,
      ...(treatment
        ? {
            dispatchStartedAt: options.dispatchStartedAt ?? T0,
            ...(outcome === "pending"
              ? {
                  claimedAt: options.dispatchStartedAt ?? T0,
                  claimExpiresAt: new Date((options.dispatchStartedAt ?? T0).getTime() + 60_000),
                  claimToken: randomUUID(),
                  attempts: 1,
                  lastAttemptAt: options.dispatchStartedAt ?? T0,
                }
              : {}),
            ...(outcome === "sent"
              ? { sentAt, publicReplyId: `179${randomUUID().slice(0, 8)}` }
              : {}),
          }
        : {}),
    },
  });
}

async function wipe(): Promise<void> {
  await db.dmMessage.deleteMany({ where: { thread: { igUserId: { startsWith: prefix } } } });
  await db.dmThread.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCandidate.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.recoveryCampaign.deleteMany({ where: { selectionVersion: { startsWith: prefix } } });
  await db.journeyIntent.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.conversation.deleteMany({ where: { igUserId: { startsWith: prefix } } });
  await db.igUser.deleteMany({ where: { id: { startsWith: prefix } } });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  attribution = await import("./historicalRecoveryAttribution.js");
  ({ historicalRecoveryRouter } = await import("../api/historicalRecovery.routes.js"));
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

beforeEach(async () => {
  if (!db) return;
  intentSequence = 0;
  await wipe();
});

afterAll(async () => {
  if (!db) return;
  await wipe();
  await db.keyword.deleteMany({ where: { id: { in: [keywordId, otherKeywordId] } } });
  await db.resource.deleteMany({ where: { id: resourceId } });
  await db.$disconnect();
});

describeWithDatabase("bounded historical recovery attribution", () => {
  it("stores the earlier event when delivery arrives later-first, then is replayed", async () => {
    const campaignId = await createCampaign();
    const row = await createCandidate({ campaignId, arm: "treatment" });
    const later = new Date(T0.getTime() + 40 * 3600_000);
    const earlier = new Date(T0.getTime() + 10 * 3600_000);

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, keywordId, at: later, kind: "completed",
    })).resolves.toBe(1);
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, keywordId, at: earlier, kind: "completed",
    })).resolves.toBe(1);
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, keywordId, at: earlier, kind: "completed",
    })).resolves.toBe(0);

    expect(await db.recoveryCandidate.findUnique({
      where: { id: row.id }, select: { laterCompletedAt: true },
    })).toEqual({ laterCompletedAt: earlier });
  });

  it("stores the chronologically earlier event under concurrent delivery", async () => {
    const campaignId = await createCampaign();
    const row = await createCandidate({ campaignId, arm: "treatment" });
    const earlier = new Date(T0.getTime() + 5 * 3600_000);
    const later = new Date(T0.getTime() + 20 * 3600_000);

    await Promise.all([earlier, later].map((at) => attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, keywordId, at, kind: "completed",
    })));

    expect(await db.recoveryCandidate.findUnique({
      where: { id: row.id }, select: { laterCompletedAt: true },
    })).toEqual({ laterCompletedAt: earlier });
  });

  it.each([
    ["inbound", 24, "laterInboundAt"],
    ["completed", 48, "laterCompletedAt"],
  ] as const)("includes the exact %i-hour %s boundary", async (kind, hours, column) => {
    const campaignId = await createCampaign();
    const row = await createCandidate({ campaignId, arm: "treatment" });
    const at = new Date(T0.getTime() + hours * 3600_000);

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      ...(kind === "completed" ? { keywordId } : {}),
      at,
      kind,
    })).resolves.toBe(1);
    expect((await db.recoveryCandidate.findUnique({ where: { id: row.id } }))![column])
      .toEqual(at);
  });

  it.each([
    ["inbound", 24],
    ["completed", 48],
  ] as const)("rejects %s one millisecond beyond its %i-hour window", async (kind, hours) => {
    const campaignId = await createCampaign();
    const row = await createCandidate({ campaignId, arm: "treatment" });

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      ...(kind === "completed" ? { keywordId } : {}),
      at: new Date(T0.getTime() + hours * 3600_000 + 1),
      kind,
    })).resolves.toBe(0);
  });

  it("anchors treatment at dispatch start, including an event before send confirmation", async () => {
    const campaignId = await createCampaign();
    const row = await createCandidate({
      campaignId,
      arm: "treatment",
      dispatchStartedAt: T0,
      sentAt: new Date(T0.getTime() + 10_000),
    });
    const at = new Date(T0.getTime() + 5_000);

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, at, kind: "inbound",
    })).resolves.toBe(1);
  });

  it("reconciles durable inbound and completion evidence that arrived before finalization", async () => {
    const campaignId = await createCampaign();
    const row = await createCandidate({
      campaignId,
      arm: "treatment",
      dispatchStartedAt: T0,
      outcome: "pending",
    });
    const inboundAt = new Date(T0.getTime() + 5_000);
    const completedAt = new Date(T0.getTime() + 6_000);
    await db.dmThread.create({
      data: {
        igAccountId: `${prefix}-account`,
        igUserId: row.igUserId,
        lastMessageAt: inboundAt,
        lastInboundAt: inboundAt,
        messages: {
          create: {
            instagramMessageId: `${prefix}-mid-${randomUUID()}`,
            direction: "inbound",
            type: "text",
            source: "instagram_user",
            text: "DONE",
            instagramTimestamp: inboundAt,
          },
        },
      },
    });
    await db.conversation.create({
      data: {
        igUserId: row.igUserId,
        keywordId,
        state: "completed",
        completedAt,
      },
    });

    // The live hooks run while Meta finalization is still pending and cannot yet
    // attribute the row. Both source events remain durable for reconciliation.
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, at: inboundAt, kind: "inbound",
    })).resolves.toBe(0);
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, keywordId, at: completedAt, kind: "completed",
    })).resolves.toBe(0);

    await db.recoveryCandidate.update({
      where: { id: row.id },
      data: {
        outcome: "sent",
        sentAt: new Date(T0.getTime() + 10_000),
        publicReplyId: `179${randomUUID().slice(0, 8)}`,
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      },
    });

    await expect(attribution.reconcileHistoricalRecoveryAttribution())
      .resolves.toEqual({ inbound: 1, completed: 1 });
    await expect(attribution.reconcileHistoricalRecoveryAttribution())
      .resolves.toEqual({ inbound: 0, completed: 0 });
    expect(await db.recoveryCandidate.findUnique({
      where: { id: row.id },
      select: { laterInboundAt: true, laterCompletedAt: true },
    })).toEqual({ laterInboundAt: inboundAt, laterCompletedAt: completedAt });
  });

  it("anchors holdout at campaign approval/start", async () => {
    const startedAt = new Date(T0.getTime() + 6 * 3600_000);
    const campaignId = await createCampaign({ startedAt });
    const row = await createCandidate({ campaignId, arm: "holdout" });

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      keywordId,
      at: new Date(startedAt.getTime() - 1),
      kind: "completed",
    })).resolves.toBe(0);
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      keywordId,
      at: startedAt,
      kind: "completed",
    })).resolves.toBe(1);
  });

  it("credits only successive campaigns whose own windows contain the event", async () => {
    const igUserId = `${prefix}-successive-${randomUUID()}`;
    const oldCampaignId = await createCampaign({ startedAt: T0 });
    const recentAnchor = new Date(T0.getTime() + 72 * 3600_000);
    const recentCampaignId = await createCampaign({ startedAt: recentAnchor });
    const old = await createCandidate({
      campaignId: oldCampaignId, arm: "treatment", igUserId, dispatchStartedAt: T0,
    });
    const recent = await createCandidate({
      campaignId: recentCampaignId, arm: "treatment", igUserId,
      dispatchStartedAt: recentAnchor,
    });
    const at = new Date(recentAnchor.getTime() + 3600_000);

    await expect(attribution.attributeRecoveryOutcome({
      igUserId, at, kind: "inbound",
    })).resolves.toBe(1);
    expect(await db.recoveryCandidate.findMany({
      where: { id: { in: [old.id, recent.id] } },
      orderBy: { id: "asc" },
      select: { id: true, laterInboundAt: true },
    })).toEqual([
      { id: old.id, laterInboundAt: null },
      { id: recent.id, laterInboundAt: at },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it("fails closed when a completion has no keyword identity", async () => {
    const campaignId = await createCampaign();
    const row = await createCandidate({ campaignId, arm: "treatment" });

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId, at: new Date(T0.getTime() + 3600_000), kind: "completed",
    })).resolves.toBe(0);
  });

  it("keeps the recovered API fixed at 48 hours even when a campaign stores a wider window", async () => {
    const campaignId = await createCampaign({ completionWindowHours: 72 });
    const row = await createCandidate({ campaignId, arm: "treatment" });
    const server = express();
    server.use(historicalRecoveryRouter);

    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      keywordId,
      at: new Date(T0.getTime() + 60 * 3600_000),
      kind: "completed",
    })).resolves.toBe(1);
    const outside = await request(server)
      .get(`/candidates?campaignId=${campaignId}&view=recovered`)
      .expect(200);
    expect(outside.body.counts.recovered).toBe(0);
    expect(outside.body.candidates).toEqual([]);

    const edge = new Date(T0.getTime() + 48 * 3600_000);
    await expect(attribution.attributeRecoveryOutcome({
      igUserId: row.igUserId,
      keywordId,
      at: edge,
      kind: "completed",
    })).resolves.toBe(1);
    const inside = await request(server)
      .get(`/candidates?campaignId=${campaignId}&view=recovered`)
      .expect(200);
    expect(inside.body.counts.recovered).toBe(1);
    expect(inside.body.candidates).toEqual([
      expect.objectContaining({
        id: row.id,
        laterCompletedAt: edge.toISOString(),
        completedWithin48Hours: true,
      }),
    ]);
  });
});
