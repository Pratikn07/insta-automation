import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GraphErrorMetadata } from "./eventLogger.js";
import type { GuideDeliveryPlanResult } from "./guideDeliveryPlanner.js";
import {
  createGuideDeliveryRepository,
  type CreateGuideDeliveryPlanInput,
  type GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const BASE_TIME = new Date("2026-08-17T12:00:00.000Z");
const SAFE_ERROR: GraphErrorMetadata = {
  category: "graph_response",
  httpStatus: 429,
  graphCode: 4,
  graphSubcode: null,
  traceId: "trace_123",
  transportCode: null,
};

type Fixture = {
  conversationId: string;
  messageIds: [string, string];
  resourceId: string;
};

let prisma: PrismaClient;
let repository: GuideDeliveryRepository;
const fixtureResourceIds = new Set<string>();

function renewedLease(now: Date): Date {
  return new Date(now.getTime() + 60_000);
}

function successfulPlan(
  messageIds: readonly [string, string],
  firstText = "First immutable snapshot",
): GuideDeliveryPlanResult {
  return {
    ok: true,
    units: [
      {
        resourceMessageId: messageIds[0],
        position: 0,
        origin: "resource_step",
        kind: "text",
        textSnapshot: firstText,
        mediaUrlSnapshot: null,
        contentFingerprint: "a".repeat(64),
      },
      {
        resourceMessageId: messageIds[1],
        position: 1,
        origin: "resource_step",
        kind: "image",
        textSnapshot: null,
        mediaUrlSnapshot: "https://cdn.example.test/guide.jpg",
        contentFingerprint: "b".repeat(64),
      },
    ],
  };
}

async function createFixture(): Promise<Fixture> {
  const resourceId = randomUUID();
  const keywordId = randomUUID();
  const conversationId = randomUUID();
  const messageIds: [string, string] = [randomUUID(), randomUUID()];
  fixtureResourceIds.add(resourceId);

  await prisma.resource.create({ data: { id: resourceId, name: `Task 6 ${resourceId}` } });
  await prisma.resourceMessage.createMany({
    data: [
      {
        id: messageIds[0],
        resourceId,
        order: 0,
        type: "text",
        body: "First current content",
      },
      {
        id: messageIds[1],
        resourceId,
        order: 1,
        type: "image",
        mediaUrl: "https://cdn.example.test/current.jpg",
      },
    ],
  });
  await prisma.keyword.create({
    data: {
      id: keywordId,
      keyword: `task6-${randomUUID()}`,
      resourceId,
      publicReply: "reply",
      gateMessage: "gate",
      active: false,
    },
  });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      igUserId: `task6-${randomUUID()}`,
      keywordId,
    },
  });

  return { conversationId, messageIds, resourceId };
}

function planInput(
  fixture: Fixture,
  overrides: Partial<CreateGuideDeliveryPlanInput> = {},
): CreateGuideDeliveryPlanInput {
  return {
    conversationId: fixture.conversationId,
    resourceId: fixture.resourceId,
    threadId: null,
    triggerKind: "inbound_reply",
    triggerId: randomUUID(),
    triggeredAt: BASE_TIME,
    sendWindowExpiresAt: new Date(BASE_TIME.getTime() + 24 * 60 * 60 * 1_000),
    followerAtTrigger: true,
    plan: successfulPlan(fixture.messageIds),
    ...overrides,
  };
}

async function createAndClaim(fixture: Fixture, maxAttempts = 3) {
  const localRepository =
    maxAttempts === 3
      ? repository
      : createGuideDeliveryRepository({ database: prisma, maxAttempts });
  const planned = await localRepository.createOrLoadPlan(planInput(fixture));
  const claim = await localRepository.claimById({
    deliveryId: planned.id,
    now: BASE_TIME,
    claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
  });
  expect(claim).not.toBeNull();
  return { claim: claim!, planned, repository: localRepository };
}

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(LOOPBACK_HOSTS).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repository = createGuideDeliveryRepository({ database: prisma, maxAttempts: 3 });
});

afterEach(async () => {
  if (!databaseUrl || fixtureResourceIds.size === 0) return;
  const resourceIds = [...fixtureResourceIds];
  await prisma.$executeRaw`
    DELETE FROM "event_log"
    WHERE "payload"->>'resourceId' = ANY(${resourceIds}::text[])
  `;
  await prisma.guideDelivery.deleteMany({ where: { resourceId: { in: resourceIds } } });
  await prisma.conversation.deleteMany({ where: { keyword: { resourceId: { in: resourceIds } } } });
  await prisma.keyword.deleteMany({ where: { resourceId: { in: resourceIds } } });
  await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
  fixtureResourceIds.clear();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase("guide delivery repository PostgreSQL contract", () => {
  it("collapses concurrent planning to one delivery and one exact unit snapshot", async () => {
    const fixture = await createFixture();
    const input = planInput(fixture);

    const [left, right] = await Promise.all([
      repository.createOrLoadPlan(input),
      repository.createOrLoadPlan(input),
    ]);

    expect(left.id).toBe(right.id);
    expect(left.units).toEqual(right.units);
    expect(left.units.map((unit) => [unit.position, unit.kind, unit.textSnapshot])).toEqual([
      [0, "text", "First immutable snapshot"],
      [1, "image", null],
    ]);
    await expect(prisma.guideDelivery.count({ where: { triggerId: input.triggerId } })).resolves.toBe(
      1,
    );
    await expect(prisma.guideDeliveryUnit.count({ where: { deliveryId: left.id } })).resolves.toBe(
      2,
    );
  });

  it("returns the first immutable snapshot when replay input contains edited content", async () => {
    const fixture = await createFixture();
    const triggerId = randomUUID();
    const first = await repository.createOrLoadPlan(
      planInput(fixture, { triggerId, plan: successfulPlan(fixture.messageIds, "Original") }),
    );
    const replay = await repository.createOrLoadPlan(
      planInput(fixture, { triggerId, plan: successfulPlan(fixture.messageIds, "Edited later") }),
    );

    expect(replay.id).toBe(first.id);
    expect(replay.units[0]?.textSnapshot).toBe("Original");
    expect(replay.units[0]?.contentFingerprint).toBe("a".repeat(64));
  });

  it("persists a preflight failure as one terminal plan without units or private content events", async () => {
    const fixture = await createFixture();
    const privateSentinel = "PRIVATE-TASK6-SENTINEL";
    const input = planInput(fixture, {
      plan: {
        ok: false,
        error: {
          code: "text_too_long",
          resourceMessageId: fixture.messageIds[0],
          authoredOrder: 0,
          unitKind: "text",
          actualLength: 1_001,
          limit: 1_000,
          privateText: privateSentinel,
        },
      } as GuideDeliveryPlanResult,
    });
    await prisma.resourceMessage.update({
      where: { id: fixture.messageIds[0] },
      data: { body: privateSentinel },
    });

    const failed = await repository.createOrLoadPlan(input);
    const event = await prisma.eventLog.findFirst({
      where: { kind: "guide_delivery_preflight_rejected" },
      orderBy: { createdAt: "desc" },
    });

    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("invalid_plan");
    expect(failed.units).toEqual([]);
    expect(JSON.stringify(event?.payload)).not.toContain(privateSentinel);
    expect(event?.payload).toMatchObject({
      deliveryId: failed.id,
      resourceId: fixture.resourceId,
      error: { code: "text_too_long", actualLength: 1_001 },
    });
  });

  it("terminalizes an empty successful plan so it can never be claimed as completion-only", async () => {
    const fixture = await createFixture();
    const empty = await repository.createOrLoadPlan(planInput(fixture, { plan: { ok: true, units: [] } }));

    expect(empty).toMatchObject({ status: "failed", failureCode: "invalid_plan", units: [] });
    await expect(
      repository.claimById({
        deliveryId: empty.id,
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
      }),
    ).resolves.toBeNull();
  });

  it("allows exactly one concurrent claimById winner", async () => {
    const fixture = await createFixture();
    const planned = await repository.createOrLoadPlan(planInput(fixture));

    const claims = await Promise.all([
      repository.claimById({
        deliveryId: planned.id,
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
      }),
      repository.claimById({
        deliveryId: planned.id,
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(new Set(claims.filter(Boolean).map((claim) => claim!.claimToken))).toHaveLength(1);
  });

  it("claims disjoint rows for concurrent claimDueBatch workers", async () => {
    const fixture = await createFixture();
    await Promise.all(
      Array.from({ length: 4 }, () => repository.createOrLoadPlan(planInput(fixture))),
    );

    const [left, right] = await Promise.all([
      repository.claimDueBatch({
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
        limit: 2,
      }),
      repository.claimDueBatch({
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
        limit: 2,
      }),
    ]);
    const leftIds = new Set(left.map((delivery) => delivery.id));
    const rightIds = new Set(right.map((delivery) => delivery.id));

    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect([...leftIds].filter((id) => rightIds.has(id))).toEqual([]);
    expect(new Set([...leftIds, ...rightIds])).toHaveLength(4);
    expect(new Set([...left, ...right].map((delivery) => delivery.claimToken))).toHaveLength(4);
  });

  it("stores the sending checkpoint and incremented attempt before provider work", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);

    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });
    const persisted = await prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } });

    expect(unit).toMatchObject({ status: "sending", attempts: 1, sendingAt: BASE_TIME });
    expect(persisted).toMatchObject({ status: "sending", attempts: 1, sendingAt: BASE_TIME });
  });

  it("refuses to begin a unit once the current claim lease has expired", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const expiredAt = new Date(BASE_TIME.getTime() + 60_000);

    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: expiredAt,
      claimExpiresAt: new Date(expiredAt.getTime() + 60_000),
    });

    expect(unit).toBeNull();
    await expect(
      prisma.guideDeliveryUnit.findFirst({
        where: { deliveryId: claim.id },
        orderBy: { position: "asc" },
      }),
    ).resolves.toMatchObject({ status: "pending", attempts: 0 });
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      claimExpiresAt: expiredAt,
    });
  });

  it("atomically renews the claim lease while beginning a unit", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const beginAt = new Date(BASE_TIME.getTime() + 30_000);
    const renewedUntil = new Date(BASE_TIME.getTime() + 90_000);

    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: beginAt,
      claimExpiresAt: renewedUntil,
    });

    expect(unit).toMatchObject({ status: "sending", attempts: 1, sendingAt: beginAt });
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      claimExpiresAt: renewedUntil,
    });
  });

  it("does not let a stale fencing token mark a sending unit sent", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });

    await expect(
      repository.markUnitSent({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: randomUUID(),
        attempt: unit!.attempts,
        providerMessageId: "mid.stale",
        ownerConfirmedAt: null,
        now: BASE_TIME,
      }),
    ).resolves.toBe(false);
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      { status: "sending", providerMessageId: null },
    );
  });

  it("allows owner-confirmed sent without a provider message id", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });
    const confirmedAt = new Date(BASE_TIME.getTime() + 1_000);

    await expect(
      repository.markUnitSent({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: claim.claimToken,
        attempt: unit!.attempts,
        providerMessageId: null,
        ownerConfirmedAt: confirmedAt,
        now: confirmedAt,
      }),
    ).resolves.toBe(true);
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      {
        status: "sent",
        providerMessageId: null,
        ownerConfirmedAt: confirmedAt,
        sentAt: confirmedAt,
      },
    );
  });

  it("persists only allowlisted failure metadata and fences the attempt number", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });

    await expect(
      repository.markUnitRetryable({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: claim.claimToken,
        attempt: unit!.attempts + 1,
        failureCode: "provider_transient",
        nextAttemptAt: new Date(BASE_TIME.getTime() + 60_000),
        error: SAFE_ERROR,
        now: BASE_TIME,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.markUnitRetryable({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: claim.claimToken,
        attempt: unit!.attempts,
        failureCode: "provider_transient",
        nextAttemptAt: new Date(BASE_TIME.getTime() + 60_000),
        error: SAFE_ERROR,
        now: BASE_TIME,
      }),
    ).resolves.toBe(true);

    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      {
        status: "retryable",
        failureDisposition: "transient",
        errorCategory: SAFE_ERROR.category,
        errorHttpStatus: SAFE_ERROR.httpStatus,
        errorGraphCode: SAFE_ERROR.graphCode,
        errorTraceId: SAFE_ERROR.traceId,
      },
    );
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "failed",
      failureCode: "provider_transient",
      claimToken: null,
    });
  });

  it("atomically checkpoints a permanent failure and terminalizes the delivery", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });

    await expect(
      repository.markUnitFailed({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: claim.claimToken,
        attempt: unit!.attempts,
        failureCode: "provider_permanent",
        error: { ...SAFE_ERROR, httpStatus: 400, graphCode: 100 },
        now: new Date(BASE_TIME.getTime() + 1_000),
      }),
    ).resolves.toBe(true);

    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "failed",
      failureCode: "provider_permanent",
      nextAttemptAt: null,
      claimToken: null,
    });
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      { status: "failed", failureDisposition: "permanent", errorGraphCode: 100 },
    );
    await expect(
      repository.claimById({
        deliveryId: claim.id,
        now: new Date(BASE_TIME.getTime() + 120_000),
        claimExpiresAt: new Date(BASE_TIME.getTime() + 180_000),
      }),
    ).resolves.toBeNull();
  });

  it("atomically checkpoints an ambiguous outcome into owner review", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });

    await expect(
      repository.markUnitUncertain({
        deliveryId: claim.id,
        unitId: unit!.id,
        claimToken: claim.claimToken,
        attempt: unit!.attempts,
        failureCode: "provider_outcome_uncertain",
        error: {
          category: "graph_transport",
          httpStatus: null,
          graphCode: null,
          graphSubcode: null,
          traceId: null,
          transportCode: "ETIMEDOUT",
        },
        now: new Date(BASE_TIME.getTime() + 1_000),
      }),
    ).resolves.toBe(true);

    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "needs_review",
      failureCode: "provider_outcome_uncertain",
      nextAttemptAt: null,
      claimToken: null,
    });
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      { status: "uncertain", failureDisposition: null, errorTransportCode: "ETIMEDOUT" },
    );
  });

  it("enforces the automatic attempt cap and consumes one explicit owner retry", async () => {
    const fixture = await createFixture();
    const cappedRepository = createGuideDeliveryRepository({ database: prisma, maxAttempts: 1 });
    const planned = await cappedRepository.createOrLoadPlan(planInput(fixture));
    const firstClaim = await cappedRepository.claimById({
      deliveryId: planned.id,
      now: BASE_TIME,
      claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
    });
    const first = await cappedRepository.beginUnit({
      deliveryId: planned.id,
      claimToken: firstClaim!.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });
    await cappedRepository.markUnitRetryable({
      deliveryId: planned.id,
      unitId: first!.id,
      claimToken: firstClaim!.claimToken,
      attempt: first!.attempts,
      failureCode: "provider_transient",
      nextAttemptAt: new Date(BASE_TIME.getTime() + 1_000),
      error: SAFE_ERROR,
      now: BASE_TIME,
    });
    const cappedClaim = await cappedRepository.claimById({
      deliveryId: planned.id,
      now: new Date(BASE_TIME.getTime() + 2_000),
      claimExpiresAt: new Date(BASE_TIME.getTime() + 62_000),
    });

    await expect(
      cappedRepository.beginUnit({
        deliveryId: planned.id,
        claimToken: cappedClaim!.claimToken,
        now: new Date(BASE_TIME.getTime() + 2_000),
        claimExpiresAt: new Date(BASE_TIME.getTime() + 62_000),
      }),
    ).resolves.toBeNull();
    await cappedRepository.releaseClaim({
      deliveryId: planned.id,
      claimToken: cappedClaim!.claimToken,
      now: new Date(BASE_TIME.getTime() + 2_000),
    });
    const authorizedAt = new Date(BASE_TIME.getTime() + 3_000);
    await prisma.guideDeliveryUnit.update({
      where: { id: first!.id },
      data: { ownerRetryAuthorizedAt: authorizedAt, ownerRetryConsumedAt: null },
    });
    const ownerClaim = await cappedRepository.claimById({
      deliveryId: planned.id,
      now: authorizedAt,
      claimExpiresAt: new Date(authorizedAt.getTime() + 60_000),
    });
    const ownerAttempt = await cappedRepository.beginUnit({
      deliveryId: planned.id,
      claimToken: ownerClaim!.claimToken,
      now: authorizedAt,
      claimExpiresAt: renewedLease(authorizedAt),
    });

    expect(ownerAttempt).toMatchObject({ attempts: 2, ownerRetryConsumedAt: authorizedAt });
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: first!.id } })).resolves.toMatchObject(
      { ownerRetryAuthorizedAt: authorizedAt, ownerRetryConsumedAt: authorizedAt },
    );

    const ownerFailureAt = new Date(authorizedAt.getTime() + 1_000);
    await cappedRepository.markUnitRetryable({
      deliveryId: planned.id,
      unitId: ownerAttempt!.id,
      claimToken: ownerClaim!.claimToken,
      attempt: ownerAttempt!.attempts,
      failureCode: "provider_transient",
      nextAttemptAt: new Date(ownerFailureAt.getTime() + 1_000),
      error: SAFE_ERROR,
      now: ownerFailureAt,
    });
    const afterOwnerClaim = await cappedRepository.claimById({
      deliveryId: planned.id,
      now: new Date(ownerFailureAt.getTime() + 2_000),
      claimExpiresAt: new Date(ownerFailureAt.getTime() + 62_000),
    });
    await expect(
      cappedRepository.beginUnit({
        deliveryId: planned.id,
        claimToken: afterOwnerClaim!.claimToken,
        now: new Date(ownerFailureAt.getTime() + 2_000),
        claimExpiresAt: new Date(ownerFailureAt.getTime() + 62_000),
      }),
    ).resolves.toBeNull();
  });

  it("closes an expired unsent delivery instead of claiming it", async () => {
    const fixture = await createFixture();
    const triggeredAt = new Date("2026-08-15T12:00:00.000Z");
    const planned = await repository.createOrLoadPlan(
      planInput(fixture, {
        triggeredAt,
        sendWindowExpiresAt: new Date(triggeredAt.getTime() + 24 * 60 * 60 * 1_000),
      }),
    );

    await expect(
      repository.claimById({
        deliveryId: planned.id,
        now: BASE_TIME,
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
      }),
    ).resolves.toBeNull();
    await expect(prisma.guideDelivery.findUnique({ where: { id: planned.id } })).resolves.toMatchObject(
      { status: "failed", failureCode: "messaging_window_closed", nextAttemptAt: null },
    );
  });

  it("claims an all-sent delivery after window expiry for bookkeeping only", async () => {
    const fixture = await createFixture();
    const triggeredAt = new Date("2026-08-15T12:00:00.000Z");
    const sendWindowExpiresAt = new Date(triggeredAt.getTime() + 24 * 60 * 60 * 1_000);
    const planned = await repository.createOrLoadPlan(
      planInput(fixture, { triggeredAt, sendWindowExpiresAt }),
    );
    const sendNow = new Date(sendWindowExpiresAt.getTime() - 60_000);
    const firstClaim = await repository.claimById({
      deliveryId: planned.id,
      now: sendNow,
      claimExpiresAt: new Date(sendNow.getTime() + 30_000),
    });
    for (let position = 0; position < 2; position += 1) {
      const unit = await repository.beginUnit({
        deliveryId: planned.id,
        claimToken: firstClaim!.claimToken,
        now: new Date(sendNow.getTime() + position * 1_000),
        claimExpiresAt: new Date(sendNow.getTime() + 60_000 + position * 1_000),
      });
      await repository.markUnitSent({
        deliveryId: planned.id,
        unitId: unit!.id,
        claimToken: firstClaim!.claimToken,
        attempt: unit!.attempts,
        providerMessageId: `mid.closed.${position}`,
        ownerConfirmedAt: null,
        now: new Date(sendNow.getTime() + position * 1_000),
      });
    }
    await repository.releaseClaim({
      deliveryId: planned.id,
      claimToken: firstClaim!.claimToken,
      now: sendWindowExpiresAt,
    });

    const bookkeepingClaim = await repository.claimById({
      deliveryId: planned.id,
      now: BASE_TIME,
      claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000),
    });

    expect(bookkeepingClaim).toMatchObject({ id: planned.id, status: "sending" });
    expect(bookkeepingClaim!.units.every((unit) => unit.status === "sent")).toBe(true);
  });

  it("releaseClaim cannot make a permanent failed unit due", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });
    await prisma.guideDeliveryUnit.update({
      where: { id: unit!.id },
      data: { status: "failed", failureDisposition: "permanent" },
    });

    await expect(
      repository.releaseClaim({
        deliveryId: claim.id,
        claimToken: claim.claimToken,
        now: new Date(BASE_TIME.getTime() + 1_000),
      }),
    ).resolves.toBe(false);
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "sending",
      claimToken: claim.claimToken,
    });
  });

  it("reconciles a stale sending unit to uncertain review without making it retryable", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });

    const reconciliation = await repository.reconcileExpiredClaims({
      now: new Date(BASE_TIME.getTime() + 61_000),
      limit: 10,
      claimLeaseMs: 60_000,
    });

    expect(reconciliation.needsReviewDeliveryIds).toContain(claim.id);
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "needs_review",
      claimToken: null,
    });
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      { status: "uncertain", failureDisposition: null },
    );
  });

  it("releases an expired untouched claim safely but returns all-sent work for bookkeeping", async () => {
    const untouchedFixture = await createFixture();
    const sentFixture = await createFixture();
    const untouched = await createAndClaim(untouchedFixture);
    const sent = await createAndClaim(sentFixture);

    for (let position = 0; position < 2; position += 1) {
      const unit = await repository.beginUnit({
        deliveryId: sent.claim.id,
        claimToken: sent.claim.claimToken,
        now: new Date(BASE_TIME.getTime() + position * 1_000),
        claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000 + position * 1_000),
      });
      await repository.markUnitSent({
        deliveryId: sent.claim.id,
        unitId: unit!.id,
        claimToken: sent.claim.claimToken,
        attempt: unit!.attempts,
        providerMessageId: `mid.${position}`,
        ownerConfirmedAt: null,
        now: new Date(BASE_TIME.getTime() + position * 1_000),
      });
    }

    const reconciliation = await repository.reconcileExpiredClaims({
      now: new Date(BASE_TIME.getTime() + 61_000),
      limit: 10,
      claimLeaseMs: 120_000,
    });

    expect(reconciliation.releasedDeliveryIds).toContain(untouched.claim.id);
    expect(reconciliation.completionPending.map((delivery) => delivery.id)).toContain(sent.claim.id);
    const completion = reconciliation.completionPending.find(
      (delivery) => delivery.id === sent.claim.id,
    );
    expect(completion).toMatchObject({ status: "sending" });
    expect(completion!.claimToken).not.toBe(sent.claim.claimToken);
    expect(completion!.claimExpiresAt).toEqual(new Date(BASE_TIME.getTime() + 181_000));
    expect(completion!.units.every((unit) => unit.status === "sent")).toBe(true);
    await expect(
      prisma.guideDelivery.findMany({
        where: { id: { in: [untouched.claim.id, sent.claim.id] } },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: untouched.claim.id, status: "planned", claimToken: null }),
        expect.objectContaining({
          id: sent.claim.id,
          status: "sending",
          claimToken: completion!.claimToken,
        }),
      ]),
    );
  });

  it("keeps an expired claim with a permanent failed unit terminal", async () => {
    const fixture = await createFixture();
    const { claim } = await createAndClaim(fixture);
    const unit = await repository.beginUnit({
      deliveryId: claim.id,
      claimToken: claim.claimToken,
      now: BASE_TIME,
      claimExpiresAt: renewedLease(BASE_TIME),
    });
    await prisma.guideDeliveryUnit.update({
      where: { id: unit!.id },
      data: { status: "failed", failureDisposition: "permanent" },
    });

    const reconciliation = await repository.reconcileExpiredClaims({
      now: new Date(BASE_TIME.getTime() + 61_000),
      limit: 10,
      claimLeaseMs: 60_000,
    });

    expect(reconciliation.terminalDeliveryIds).toContain(claim.id);
    await expect(prisma.guideDelivery.findUnique({ where: { id: claim.id } })).resolves.toMatchObject({
      status: "failed",
      nextAttemptAt: null,
      claimToken: null,
    });
    await expect(prisma.guideDeliveryUnit.findUnique({ where: { id: unit!.id } })).resolves.toMatchObject(
      { status: "failed", failureDisposition: "permanent" },
    );
  });

  it("bounds stale reconciliation so due claims are not starved by a large backlog", async () => {
    const first = await createAndClaim(await createFixture());
    const second = await createAndClaim(await createFixture());
    const now = new Date(BASE_TIME.getTime() + 61_000);

    const reconciliation = await repository.reconcileExpiredClaims({
      now,
      limit: 1,
      claimLeaseMs: 60_000,
    });

    expect(reconciliation.releasedDeliveryIds).toHaveLength(1);
    const statuses = await prisma.guideDelivery.findMany({
      where: { id: { in: [first.claim.id, second.claim.id] } },
      select: { status: true },
    });
    expect(statuses.map((delivery) => delivery.status)).toContain("sending");
  });

  // Parent-delivery Task 1. The `generated_cover` label was appended to
  // `guide_delivery_unit_origin` by ALTER TYPE. Two things need proving at row level,
  // not just in the catalog: the two origins that live delivery rows already use are
  // still readable, and the new label is actually writable end to end.
  it("round-trips every origin after the appended enum value", async () => {
    const fixture = await createFixture();

    const plan: GuideDeliveryPlanResult = {
      ok: true,
      units: [
        {
          // A cover unit carries no authored resource message; the column is nullable.
          resourceMessageId: null,
          position: 0,
          origin: "generated_cover",
          kind: "image",
          textSnapshot: null,
          mediaUrlSnapshot: "https://cdn.example.test/cover/dm.png",
          contentFingerprint: "c".repeat(64),
        },
        {
          resourceMessageId: fixture.messageIds[0],
          position: 1,
          origin: "redelivery_intro",
          kind: "text",
          textSnapshot: "Here it is again",
          mediaUrlSnapshot: null,
          contentFingerprint: "d".repeat(64),
        },
        {
          resourceMessageId: fixture.messageIds[1],
          position: 2,
          origin: "resource_step",
          kind: "image",
          textSnapshot: null,
          mediaUrlSnapshot: "https://cdn.example.test/guide.jpg",
          contentFingerprint: "e".repeat(64),
        },
      ],
    };

    const created = await repository.createOrLoadPlan(planInput(fixture, { plan }));

    expect(created.units.map((unit) => [unit.position, unit.origin])).toEqual([
      [0, "generated_cover"],
      [1, "redelivery_intro"],
      [2, "resource_step"],
    ]);

    // Read back through Prisma too, so the assertion covers the client's enum mapping
    // and not only the repository's own return value.
    const persisted = await prisma.guideDeliveryUnit.findMany({
      where: { deliveryId: created.id },
      orderBy: { position: "asc" },
      select: { position: true, origin: true, resourceMessageId: true },
    });
    expect(persisted).toEqual([
      { position: 0, origin: "generated_cover", resourceMessageId: null },
      { position: 1, origin: "redelivery_intro", resourceMessageId: fixture.messageIds[0] },
      { position: 2, origin: "resource_step", resourceMessageId: fixture.messageIds[1] },
    ]);
  });
});
