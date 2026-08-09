import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GuideDeliveryPlanResult, PlannedGuideDeliveryUnit } from "./guideDeliveryPlanner.js";
import type {
  CreateGuideDeliveryPlanInput,
  GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let guideDeliveryRepository: GuideDeliveryRepository;
let resourceId: string;
let keywordId: string;
let conversationId: string;

const startedAt = new Date("2026-08-09T12:00:00.000Z");
const sendWindowExpiresAt = new Date("2026-08-10T12:00:00.000Z");

function unit(position: number, text: string): PlannedGuideDeliveryUnit {
  return {
    resourceMessageId: null,
    position,
    origin: "resource_step",
    kind: "text",
    textSnapshot: text,
    mediaUrlSnapshot: null,
    contentFingerprint: String(position + 1).repeat(64),
  };
}

function planInput(
  triggerId: string,
  plan: GuideDeliveryPlanResult = { ok: true, units: [unit(0, "first snapshot")] },
): CreateGuideDeliveryPlanInput {
  return {
    conversationId,
    resourceId,
    threadId: null,
    triggerKind: "inbound_reply",
    triggerId,
    triggeredAt: startedAt,
    sendWindowExpiresAt,
    followerAtTrigger: null,
    plan,
  };
}

async function createDelivery(
  plan: GuideDeliveryPlanResult = { ok: true, units: [unit(0, "first snapshot")] },
) {
  return guideDeliveryRepository.createOrLoadPlan(planInput(randomUUID(), plan));
}

async function claim(deliveryId: string, now = startedAt) {
  return guideDeliveryRepository.claimById({
    deliveryId,
    now,
    claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  guideDeliveryRepository = (await import("./guideDeliveryRepository.js"))
    .guideDeliveryRepository;
  resourceId = randomUUID();
  keywordId = randomUUID();
  conversationId = randomUUID();
  await prisma.resource.create({ data: { id: resourceId, name: "guide repository contract" } });
  await prisma.keyword.create({
    data: {
      id: keywordId,
      keyword: `guide-repository-${keywordId}`,
      resourceId,
      publicReply: "public",
      gateMessage: "gate",
    },
  });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      igUserId: `guide-repository-${randomUUID()}`,
      keywordId,
    },
  });
});

afterEach(async () => {
  if (!prisma) return;
  await prisma.guideDelivery.deleteMany({ where: { conversationId } });
  await prisma.$executeRaw`
    DELETE FROM "event_log"
    WHERE "payload"->>'conversationId' = ${conversationId}
  `;
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.keyword.deleteMany({ where: { id: keywordId } });
  await prisma.resource.deleteMany({ where: { id: resourceId } });
  await prisma.$disconnect();
});

describeWithLocalDatabase("guide delivery repository PostgreSQL contract", () => {
  it("collapses concurrent planning to one immutable delivery and one exact unit set", async () => {
    const triggerId = randomUUID();
    const input = planInput(triggerId, {
      ok: true,
      units: [unit(0, "snapshot A"), unit(1, "snapshot B")],
    });

    const [left, right] = await Promise.all([
      guideDeliveryRepository.createOrLoadPlan(input),
      guideDeliveryRepository.createOrLoadPlan(input),
    ]);

    expect(left.id).toBe(right.id);
    expect(left.units.map((row) => row.textSnapshot)).toEqual(["snapshot A", "snapshot B"]);
    expect(right.units.map((row) => row.textSnapshot)).toEqual(["snapshot A", "snapshot B"]);
    expect(await prisma.guideDelivery.count({ where: { triggerId } })).toBe(1);
    expect(await prisma.guideDeliveryUnit.count({ where: { deliveryId: left.id } })).toBe(2);
  });

  it("returns the first snapshot when a trigger replay carries edited content", async () => {
    const triggerId = randomUUID();
    const first = await guideDeliveryRepository.createOrLoadPlan(
      planInput(triggerId, { ok: true, units: [unit(0, "immutable original")] }),
    );
    const replay = await guideDeliveryRepository.createOrLoadPlan(
      planInput(triggerId, { ok: true, units: [unit(0, "edited later")] }),
    );

    expect(replay.id).toBe(first.id);
    expect(replay.units.map((row) => row.textSnapshot)).toEqual(["immutable original"]);
  });

  it("keeps a preflight failure terminal and stores no guide content in its event", async () => {
    const triggerId = randomUUID();
    const messageId = randomUUID();
    const failed = await guideDeliveryRepository.createOrLoadPlan(
      planInput(triggerId, {
        ok: false,
        error: {
          code: "text_too_long",
          resourceMessageId: messageId,
          authoredOrder: 4,
          unitKind: "text",
          actualLength: 1_001,
          limit: 1_000,
        },
      }),
    );
    const replay = await guideDeliveryRepository.createOrLoadPlan(
      planInput(triggerId, { ok: true, units: [unit(0, "PRIVATE EDITED CONTENT")] }),
    );
    const event = await prisma.eventLog.findFirstOrThrow({
      where: { kind: "guide_delivery_preflight_rejected" },
      orderBy: { createdAt: "desc" },
    });

    expect(failed).toMatchObject({ status: "failed", failureCode: "guide_preflight_failed" });
    expect(failed.units).toEqual([]);
    expect(replay.id).toBe(failed.id);
    expect(replay.units).toEqual([]);
    expect(event.payload).toMatchObject({
      deliveryId: failed.id,
      conversationId,
      resourceId,
      resourceMessageId: messageId,
      unitKind: "text",
      actualLength: 1_001,
      limit: 1_000,
    });
    expect(JSON.stringify(event.payload)).not.toContain("PRIVATE EDITED CONTENT");
  });

  it("lets exactly one concurrent claimById caller win", async () => {
    const delivery = await createDelivery();
    const [left, right] = await Promise.all([claim(delivery.id), claim(delivery.id)]);

    expect([left, right].filter((value) => value !== null)).toHaveLength(1);
    const stored = await prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored.status).toBe("sending");
    expect(stored.claimToken).toBe([left, right].find((value) => value !== null)?.claimToken);
  });

  it("gives concurrent due-batch workers disjoint rows", async () => {
    const deliveries = await Promise.all(
      Array.from({ length: 4 }, () => createDelivery()),
    );
    const input = {
      now: startedAt,
      claimExpiresAt: new Date(startedAt.getTime() + 5 * 60_000),
      limit: 2,
    };

    const [left, right] = await Promise.all([
      guideDeliveryRepository.claimDueBatch(input),
      guideDeliveryRepository.claimDueBatch(input),
    ]);
    const leftIds = new Set(left.map((row) => row.id));
    const rightIds = new Set(right.map((row) => row.id));

    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect([...leftIds].filter((id) => rightIds.has(id))).toEqual([]);
    expect(new Set([...leftIds, ...rightIds])).toEqual(new Set(deliveries.map((row) => row.id)));
  });

  it("increments attempts and records sendingAt before returning a unit", async () => {
    const delivery = await createDelivery();
    const claimed = await claim(delivery.id);
    expect(claimed).not.toBeNull();

    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: startedAt,
      maxAttempts: 3,
    });
    const stored = await prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: begun!.id } });

    expect(begun).toMatchObject({ attempts: 1, status: "sending", sendingAt: startedAt });
    expect(stored).toMatchObject({ attempts: 1, status: "sending", sendingAt: startedAt });
  });

  it("fences a sent checkpoint by token, unit ownership, status, and attempt", async () => {
    const delivery = await createDelivery();
    const claimed = await claim(delivery.id);
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: startedAt,
      maxAttempts: 3,
    });

    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: delivery.id,
        unitId: begun!.id,
        claimToken: randomUUID(),
        attempt: begun!.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-stale",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);
    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: delivery.id,
        unitId: begun!.id,
        claimToken: claimed!.claimToken,
        attempt: begun!.attempts + 1,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-wrong-attempt",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);

    expect(await prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: begun!.id } })).toMatchObject({
      status: "sending",
      attempts: 1,
      providerMessageId: null,
    });
  });

  it("allows owner-confirmed sent without a provider message id", async () => {
    const delivery = await createDelivery();
    const claimed = await claim(delivery.id);
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: startedAt,
      maxAttempts: 3,
    });
    const ownerConfirmedAt = new Date(startedAt.getTime() + 2_000);

    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: delivery.id,
        unitId: begun!.id,
        claimToken: claimed!.claimToken,
        attempt: begun!.attempts,
        sentAt: ownerConfirmedAt,
        providerMessageId: null,
        ownerConfirmedAt,
      }),
    ).resolves.toBe(true);

    expect(await prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: begun!.id } })).toMatchObject({
      status: "sent",
      providerMessageId: null,
      sentAt: ownerConfirmedAt,
      ownerConfirmedAt,
    });
  });

  it("enforces the automatic cap and atomically consumes one owner authorization", async () => {
    const delivery = await createDelivery();
    const claimed = await claim(delivery.id);
    const row = await prisma.guideDeliveryUnit.findFirstOrThrow({ where: { deliveryId: delivery.id } });
    await prisma.guideDeliveryUnit.update({
      where: { id: row.id },
      data: {
        status: "failed",
        attempts: 3,
        sendingAt: startedAt,
        failureDisposition: "transient",
      },
    });

    await expect(
      guideDeliveryRepository.beginUnit({
        deliveryId: delivery.id,
        claimToken: claimed!.claimToken,
        now: new Date(startedAt.getTime() + 1_000),
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();

    const ownerRetryAuthorizedAt = new Date(startedAt.getTime() + 2_000);
    await prisma.guideDeliveryUnit.update({
      where: { id: row.id },
      data: { ownerRetryAuthorizedAt },
    });
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: new Date(startedAt.getTime() + 3_000),
      maxAttempts: 3,
    });

    expect(begun).toMatchObject({ attempts: 4, status: "sending" });
    expect(begun!.ownerRetryConsumedAt).toEqual(new Date(startedAt.getTime() + 3_000));
    expect(await prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      attempts: 4,
      ownerRetryAuthorizedAt,
      ownerRetryConsumedAt: new Date(startedAt.getTime() + 3_000),
    });
  });

  it("turns an expired sending unit uncertain and clears the claim into review", async () => {
    const delivery = await createDelivery();
    const claimAt = new Date(startedAt.getTime() - 10 * 60_000);
    const claimed = await guideDeliveryRepository.claimById({
      deliveryId: delivery.id,
      now: claimAt,
      claimExpiresAt: new Date(claimAt.getTime() + 60_000),
    });
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: new Date(claimAt.getTime() + 1_000),
      maxAttempts: 3,
    });

    const result = await guideDeliveryRepository.reconcileExpiredClaims(startedAt);
    const [storedDelivery, storedUnit] = await Promise.all([
      prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: begun!.id } }),
    ]);

    expect(result.needsReviewDeliveryIds).toContain(delivery.id);
    expect(storedDelivery).toMatchObject({ status: "needs_review", claimToken: null });
    expect(storedUnit.status).toBe("uncertain");
  });

  it("releases an expired claim that never crossed a provider boundary", async () => {
    const delivery = await createDelivery();
    const claimAt = new Date(startedAt.getTime() - 10 * 60_000);
    await guideDeliveryRepository.claimById({
      deliveryId: delivery.id,
      now: claimAt,
      claimExpiresAt: new Date(claimAt.getTime() + 60_000),
    });

    const result = await guideDeliveryRepository.reconcileExpiredClaims(startedAt);
    const stored = await prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } });

    expect(result.releasedDeliveryIds).toContain(delivery.id);
    expect(stored).toMatchObject({ status: "planned", claimToken: null, nextAttemptAt: startedAt });
  });

  it("rotates an expired all-sent claim and returns completion-only work", async () => {
    const delivery = await createDelivery();
    const claimAt = new Date(startedAt.getTime() - 10 * 60_000);
    const claimed = await guideDeliveryRepository.claimById({
      deliveryId: delivery.id,
      now: claimAt,
      claimExpiresAt: new Date(claimAt.getTime() + 60_000),
    });
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed!.claimToken,
      now: new Date(claimAt.getTime() + 1_000),
      maxAttempts: 3,
    });
    await guideDeliveryRepository.markUnitSent({
      deliveryId: delivery.id,
      unitId: begun!.id,
      claimToken: claimed!.claimToken,
      attempt: begun!.attempts,
      sentAt: new Date(claimAt.getTime() + 2_000),
      providerMessageId: "mid-confirmed",
      ownerConfirmedAt: null,
    });

    const result = await guideDeliveryRepository.reconcileExpiredClaims(startedAt);
    const completion = result.completionPending.find((row) => row.id === delivery.id);

    expect(completion).toMatchObject({ id: delivery.id, status: "sending" });
    expect(completion!.claimToken).not.toBe(claimed!.claimToken);
    expect(completion!.units.map((row) => row.status)).toEqual(["sent"]);
  });
});
