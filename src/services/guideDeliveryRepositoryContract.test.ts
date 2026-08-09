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
let conversationIgUserId: string;

const startedAt = new Date("2026-08-09T12:00:00.000Z");
const sendWindowExpiresAt = new Date("2026-08-10T12:00:00.000Z");
const afterWindow = new Date(sendWindowExpiresAt.getTime() + 1_000);

const permanentError = {
  category: "graph_response" as const,
  httpStatus: 400,
  graphCode: 100,
  graphSubcode: 33,
  traceId: "safe_trace_permanent",
  transportCode: null,
};

const uncertainError = {
  category: "graph_transport" as const,
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
  transportCode: "ETIMEDOUT" as const,
};

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
  overrides: Partial<Omit<CreateGuideDeliveryPlanInput, "triggerId" | "plan">> = {},
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
    ...overrides,
    plan,
  };
}

async function createDelivery(
  plan: GuideDeliveryPlanResult = { ok: true, units: [unit(0, "first snapshot")] },
  overrides: Partial<Omit<CreateGuideDeliveryPlanInput, "triggerId" | "plan">> = {},
) {
  return guideDeliveryRepository.createOrLoadPlan(planInput(randomUUID(), plan, overrides));
}

async function claim(deliveryId: string, now = startedAt) {
  return guideDeliveryRepository.claimById({
    deliveryId,
    now,
    claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
  });
}

async function eventsFor(deliveryId: string) {
  return prisma.$queryRaw<Array<{ id: string; kind: string; payload: unknown }>>`
    SELECT "id", "kind", "payload"
    FROM "event_log"
    WHERE "payload"->>'deliveryId' = ${deliveryId}
    ORDER BY "created_at", "id"
  `;
}

async function storedState(deliveryId: string) {
  const delivery = await prisma.guideDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { units: { orderBy: { position: "asc" } } },
  });
  return { delivery, events: await eventsFor(deliveryId) };
}

async function activeUnit(text = "PRIVATE FENCE SENTINEL") {
  const delivery = await createDelivery({ ok: true, units: [unit(0, text)] });
  const claimed = await claim(delivery.id);
  if (!claimed) throw new Error("expected claimed delivery fixture");
  const begun = await guideDeliveryRepository.beginUnit({
    deliveryId: delivery.id,
    claimToken: claimed.claimToken,
    now: startedAt,
    maxAttempts: 3,
  });
  if (!begun) throw new Error("expected begun unit fixture");
  return { delivery, claimed, begun };
}

async function activeUnitAtAttempt(attempt: number, text = "PRIVATE ATTEMPT SENTINEL") {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid test attempt");
  const delivery = await createDelivery({ ok: true, units: [unit(0, text)] });
  const claimed = await claim(delivery.id);
  if (!claimed) throw new Error("expected claimed delivery fixture");
  const storedUnit = await prisma.guideDeliveryUnit.findFirstOrThrow({
    where: { deliveryId: delivery.id },
  });
  await prisma.guideDeliveryUnit.update({
    where: { id: storedUnit.id },
    data: { attempts: attempt - 1 },
  });
  const begun = await guideDeliveryRepository.beginUnit({
    deliveryId: delivery.id,
    claimToken: claimed.claimToken,
    now: startedAt,
    maxAttempts: attempt,
  });
  if (!begun) throw new Error("expected begun unit fixture");
  return { delivery, claimed, begun };
}

async function needsReviewDelivery(
  unitCount = 1,
  expiresAt = sendWindowExpiresAt,
) {
  const delivery = await createDelivery(
    { ok: true, units: Array.from({ length: unitCount }, (_, position) => unit(position, `PRIVATE REVIEW ${position}`)) },
    { sendWindowExpiresAt: expiresAt },
  );
  const claimed = await claim(delivery.id);
  if (!claimed) throw new Error("expected review delivery claim");
  for (let position = 0; position < unitCount - 1; position += 1) {
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: delivery.id,
      claimToken: claimed.claimToken,
      now: new Date(startedAt.getTime() + position + 1),
      maxAttempts: 3,
    });
    if (!begun) throw new Error("expected sent prefix unit");
    await guideDeliveryRepository.markUnitSent({
      deliveryId: delivery.id,
      unitId: begun.id,
      claimToken: claimed.claimToken,
      attempt: begun.attempts,
      sentAt: new Date(startedAt.getTime() + position + 100),
      providerMessageId: `provider-prefix-${position}`,
      ownerConfirmedAt: null,
    });
  }
  const uncertain = await guideDeliveryRepository.beginUnit({
    deliveryId: delivery.id,
    claimToken: claimed.claimToken,
    now: new Date(startedAt.getTime() + 500),
    maxAttempts: 3,
  });
  if (!uncertain) throw new Error("expected uncertain unit");
  await guideDeliveryRepository.markUnitUncertain({
    deliveryId: delivery.id,
    unitId: uncertain.id,
    claimToken: claimed.claimToken,
    attempt: uncertain.attempts,
    uncertainAt: new Date(startedAt.getTime() + 600),
    error: uncertainError,
  });
  return { delivery, uncertain };
}

async function allSentUnclaimed() {
  const fixture = await activeUnit("completion-only snapshot");
  const sentAt = new Date(startedAt.getTime() + 1_000);
  await expect(
    guideDeliveryRepository.markUnitSent({
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      claimToken: fixture.claimed.claimToken,
      attempt: fixture.begun.attempts,
      sentAt,
      providerMessageId: `mid-${fixture.delivery.id}`,
      ownerConfirmedAt: null,
    }),
  ).resolves.toBe(true);
  await expect(
    guideDeliveryRepository.releaseClaim({
      deliveryId: fixture.delivery.id,
      claimToken: fixture.claimed.claimToken,
      now: new Date(sentAt.getTime() + 1_000),
    }),
  ).resolves.toBe(true);
  return fixture.delivery.id;
}

async function legacyEmptyPlannedDelivery() {
  return prisma.guideDelivery.create({
    data: {
      conversationId,
      resourceId,
      threadId: null,
      triggerKind: "inbound_reply",
      triggerId: randomUUID(),
      triggeredAt: startedAt,
      sendWindowExpiresAt,
      followerAtTrigger: null,
      status: "planned",
    },
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
  conversationIgUserId = `guide-repository-${randomUUID()}`;
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
      igUserId: conversationIgUserId,
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
    const events = await eventsFor(left.id);
    expect(events.filter((event) => event.kind === "guide_delivery_planned")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "guide_delivery_preflight_rejected")).toHaveLength(0);
  });

  it("collapses concurrent empty successful plans into one immutable terminal rejection", async () => {
    const triggerId = randomUUID();
    const emptyInput = planInput(triggerId, { ok: true, units: [] });

    const [left, right] = await Promise.all([
      guideDeliveryRepository.createOrLoadPlan(emptyInput),
      guideDeliveryRepository.createOrLoadPlan(emptyInput),
    ]);
    const replay = await guideDeliveryRepository.createOrLoadPlan(
      planInput(triggerId, { ok: true, units: [unit(0, "PRIVATE LATER CONTENT")] }),
    );
    const events = await eventsFor(left.id);

    expect(left.id).toBe(right.id);
    expect(replay.id).toBe(left.id);
    expect(left).toMatchObject({ status: "failed", failureCode: "guide_preflight_failed" });
    expect(left.units).toEqual([]);
    expect(replay).toMatchObject({ status: "failed", failureCode: "guide_preflight_failed" });
    expect(replay.units).toEqual([]);
    expect(await prisma.guideDelivery.count({ where: { triggerId } })).toBe(1);
    expect(events.filter((event) => event.kind === "guide_delivery_planned")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "guide_delivery_preflight_rejected")).toHaveLength(1);
    expect(events.find((event) => event.kind === "guide_delivery_preflight_rejected")?.payload)
      .toMatchObject({
        deliveryId: left.id,
        conversationId,
        resourceId,
        preflightCode: "empty_plan",
        unitCount: 0,
      });
    expect(JSON.stringify(events)).not.toContain("PRIVATE LATER CONTENT");
  });

  it("never claims an empty plan directly or in a due batch within or after the window", async () => {
    const directWithin = await createDelivery({ ok: true, units: [] });
    const directAfter = await createDelivery({ ok: true, units: [] });
    const batchWithin = await createDelivery({ ok: true, units: [] });
    const batchAfter = await createDelivery({ ok: true, units: [] });

    await expect(claim(directWithin.id, startedAt)).resolves.toBeNull();
    await expect(claim(directAfter.id, afterWindow)).resolves.toBeNull();
    const withinClaims = await guideDeliveryRepository.claimDueBatch({
      now: startedAt,
      claimExpiresAt: new Date(startedAt.getTime() + 60_000),
      limit: 10,
    });
    expect(withinClaims.map((row) => row.id)).not.toContain(batchWithin.id);
    const afterClaims = await guideDeliveryRepository.claimDueBatch({
      now: afterWindow,
      claimExpiresAt: new Date(afterWindow.getTime() + 60_000),
      limit: 10,
    });
    expect(afterClaims.map((row) => row.id)).not.toContain(batchAfter.id);

    for (const delivery of [directWithin, directAfter, batchWithin, batchAfter]) {
      expect(await prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .toMatchObject({
          status: "failed",
          failureCode: "guide_preflight_failed",
          claimToken: null,
        });
      expect(await prisma.guideDeliveryUnit.count({ where: { deliveryId: delivery.id } })).toBe(0);
    }
  });

  it("terminalizes a legacy zero-unit row instead of treating it as completion after the window", async () => {
    const directEmpty = await legacyEmptyPlannedDelivery();
    const batchEmpty = await legacyEmptyPlannedDelivery();

    await expect(claim(directEmpty.id, afterWindow)).resolves.toBeNull();
    const batchClaims = await guideDeliveryRepository.claimDueBatch({
      now: afterWindow,
      claimExpiresAt: new Date(afterWindow.getTime() + 60_000),
      limit: 10,
    });

    expect(batchClaims.map((row) => row.id)).not.toContain(batchEmpty.id);
    for (const delivery of [directEmpty, batchEmpty]) {
      expect(await prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .toMatchObject({
          status: "failed",
          failureCode: "guide_preflight_failed",
          claimToken: null,
        });
      expect((await eventsFor(delivery.id)).filter(
        (event) => event.kind === "guide_delivery_preflight_rejected",
      )).toHaveLength(1);
    }
  });

  it("terminalizes legacy zero-unit rows before direct or batch claims inside the window", async () => {
    const directEmpty = await legacyEmptyPlannedDelivery();
    const batchEmpty = await legacyEmptyPlannedDelivery();

    const directResult = await claim(directEmpty.id, startedAt);
    const batchResults = await guideDeliveryRepository.claimDueBatch({
      now: startedAt,
      claimExpiresAt: new Date(startedAt.getTime() + 60_000),
      limit: 10,
    });

    expect(directResult).toBeNull();
    expect(batchResults.map((row) => row.id)).not.toContain(batchEmpty.id);
    for (const delivery of [directEmpty, batchEmpty]) {
      expect(await prisma.guideDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .toMatchObject({
          status: "failed",
          failureCode: "guide_preflight_failed",
          claimToken: null,
        });
      const rejectionEvents = (await eventsFor(delivery.id)).filter(
        (event) => event.kind === "guide_delivery_preflight_rejected",
      );
      expect(rejectionEvents).toHaveLength(1);
      expect(rejectionEvents[0]?.payload).toMatchObject({
        deliveryId: delivery.id,
        conversationId,
        resourceId,
        preflightCode: "empty_plan",
        unitCount: 0,
      });
    }
  });

  it("agrees across direct and batch claims at the expired-window completion boundary", async () => {
    const directAllSentId = await allSentUnclaimed();
    const batchAllSentId = await allSentUnclaimed();
    const directUnsent = await createDelivery();
    const batchUnsent = await createDelivery();

    const directCompletion = await claim(directAllSentId, afterWindow);
    expect(directCompletion).toMatchObject({ id: directAllSentId, status: "sending" });
    await expect(claim(directUnsent.id, afterWindow)).resolves.toBeNull();

    const batchClaims = await guideDeliveryRepository.claimDueBatch({
      now: afterWindow,
      claimExpiresAt: new Date(afterWindow.getTime() + 60_000),
      limit: 10,
    });
    expect(batchClaims.map((row) => row.id)).toContain(batchAllSentId);
    expect(batchClaims.map((row) => row.id)).not.toContain(batchUnsent.id);

    expect(await prisma.guideDelivery.findUniqueOrThrow({ where: { id: directUnsent.id } }))
      .toMatchObject({ status: "failed", failureCode: "messaging_window_closed", claimToken: null });
    expect(await prisma.guideDelivery.findUniqueOrThrow({ where: { id: batchUnsent.id } }))
      .toMatchObject({ status: "failed", failureCode: "messaging_window_closed", claimToken: null });
    expect((await eventsFor(directUnsent.id)).filter((event) => event.kind === "guide_delivery_window_closed"))
      .toHaveLength(1);
    expect((await eventsFor(batchUnsent.id)).filter((event) => event.kind === "guide_delivery_window_closed"))
      .toHaveLength(1);
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

    await expect(
      guideDeliveryRepository.findByTrigger({
        triggerKind: first.triggerKind,
        triggerId: first.triggerId,
      }),
    ).resolves.toMatchObject({ id: first.id, units: [{ textSnapshot: "immutable original" }] });
    await expect(guideDeliveryRepository.findById(first.id)).resolves.toMatchObject({
      id: first.id,
      units: [{ textSnapshot: "immutable original" }],
    });
    await expect(guideDeliveryRepository.findRecipientIgUserId(first.id)).resolves.toBe(
      conversationIgUserId,
    );
  });

  it("atomically completes a nonempty all-sent delivery and emits sequence_completed once", async () => {
    const fixture = await activeUnit("PRIVATE COMPLETION SNAPSHOT");
    const sentAt = new Date(startedAt.getTime() + 1_000);
    await guideDeliveryRepository.markUnitSent({
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      claimToken: fixture.claimed.claimToken,
      attempt: fixture.begun.attempts,
      sentAt,
      providerMessageId: "mid-completion",
      ownerConfirmedAt: null,
    });

    await expect(
      guideDeliveryRepository.finalizeCompleted({
        deliveryId: fixture.delivery.id,
        claimToken: fixture.claimed.claimToken,
        completedAt: sentAt,
      }),
    ).resolves.toBe("completed");
    await expect(
      guideDeliveryRepository.finalizeCompleted({
        deliveryId: fixture.delivery.id,
        claimToken: randomUUID(),
        completedAt: new Date(sentAt.getTime() + 1_000),
      }),
    ).resolves.toBe("already_completed");

    const state = await storedState(fixture.delivery.id);
    expect(state.delivery).toMatchObject({
      status: "completed",
      completedAt: sentAt,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    });
    const completedEvents = state.events.filter((event) => event.kind === "sequence_completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload).toMatchObject({
      deliveryId: fixture.delivery.id,
      conversationId,
      resourceId,
      triggerKind: "inbound_reply",
      triggerId: fixture.delivery.triggerId,
      unitCount: 1,
      followerAtTrigger: null,
    });
    expect(JSON.stringify(completedEvents)).not.toContain("PRIVATE COMPLETION SNAPSHOT");
  });

  it("refuses completion for zero units, non-sent units, and stale claims without state drift", async () => {
    const zeroClaimToken = randomUUID();
    const zero = await prisma.guideDelivery.create({
      data: {
        conversationId,
        resourceId,
        triggerKind: "inbound_reply",
        triggerId: randomUUID(),
        triggeredAt: startedAt,
        sendWindowExpiresAt,
        status: "sending",
        claimToken: zeroClaimToken,
        claimedAt: startedAt,
        claimExpiresAt: new Date(startedAt.getTime() + 60_000),
      },
    });
    const zeroBefore = await storedState(zero.id);
    await expect(
      guideDeliveryRepository.finalizeCompleted({
        deliveryId: zero.id,
        claimToken: zeroClaimToken,
        completedAt: startedAt,
      }),
    ).resolves.toBe("not_ready");
    expect(await storedState(zero.id)).toEqual(zeroBefore);

    const pending = await createDelivery();
    const pendingClaim = await claim(pending.id);
    const pendingBefore = await storedState(pending.id);
    await expect(
      guideDeliveryRepository.finalizeCompleted({
        deliveryId: pending.id,
        claimToken: pendingClaim!.claimToken,
        completedAt: startedAt,
      }),
    ).resolves.toBe("not_ready");
    expect(await storedState(pending.id)).toEqual(pendingBefore);

    await expect(
      guideDeliveryRepository.finalizeCompleted({
        deliveryId: pending.id,
        claimToken: randomUUID(),
        completedAt: startedAt,
      }),
    ).resolves.toBe("lost_claim");
    expect(await storedState(pending.id)).toEqual(pendingBefore);
  });

  it("fenced window closure terminalizes begun and untouched work without provider metadata", async () => {
    const begunFixture = await activeUnit("PRIVATE WINDOW SNAPSHOT");
    const closedAt = new Date(startedAt.getTime() + 1_000);
    await expect(
      guideDeliveryRepository.markWindowClosed({
        deliveryId: begunFixture.delivery.id,
        claimToken: begunFixture.claimed.claimToken,
        closedAt,
        unitId: begunFixture.begun.id,
        attempt: begunFixture.begun.attempts,
      }),
    ).resolves.toBe(true);

    const untouched = await createDelivery();
    const untouchedClaim = await claim(untouched.id);
    await expect(
      guideDeliveryRepository.markWindowClosed({
        deliveryId: untouched.id,
        claimToken: untouchedClaim!.claimToken,
        closedAt,
      }),
    ).resolves.toBe(true);

    for (const deliveryId of [begunFixture.delivery.id, untouched.id]) {
      const state = await storedState(deliveryId);
      expect(state.delivery).toMatchObject({
        status: "failed",
        failureCode: "messaging_window_closed",
        nextAttemptAt: null,
        claimToken: null,
      });
      expect(state.events.filter((event) => event.kind === "guide_delivery_window_closed"))
        .toHaveLength(1);
      expect(JSON.stringify(state.events)).not.toContain("PRIVATE WINDOW SNAPSHOT");
    }
    expect(await prisma.guideDeliveryUnit.findUniqueOrThrow({ where: { id: begunFixture.begun.id } }))
      .toMatchObject({ status: "failed", failureDisposition: "permanent" });
  });

  it("terminalizes an exhausted transient unit without changing its provider classification", async () => {
    const fixture = await activeUnit("PRIVATE CAP SNAPSHOT");
    const failedAt = new Date(startedAt.getTime() + 1_000);
    await guideDeliveryRepository.markUnitFailed({
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      claimToken: fixture.claimed.claimToken,
      attempt: fixture.begun.attempts,
      failedAt,
      disposition: "transient",
      nextAttemptAt: failedAt,
      terminalReason: null,
      error: { ...permanentError, httpStatus: 503, graphCode: 2 },
    });
    await prisma.guideDeliveryUnit.update({
      where: { id: fixture.begun.id },
      data: { attempts: 3 },
    });
    const reclaimed = await claim(fixture.delivery.id, failedAt);

    await expect(
      guideDeliveryRepository.markAttemptsExhausted({
        deliveryId: fixture.delivery.id,
        claimToken: reclaimed!.claimToken,
        exhaustedAt: new Date(failedAt.getTime() + 1_000),
        maxAttempts: 3,
      }),
    ).resolves.toBe(true);

    const state = await storedState(fixture.delivery.id);
    expect(state.delivery).toMatchObject({
      status: "failed",
      failureCode: "guide_unit_attempts_exhausted",
      nextAttemptAt: null,
      claimToken: null,
    });
    expect(state.delivery.units[0]).toMatchObject({
      status: "failed",
      failureDisposition: "transient",
      attempts: 3,
    });
    expect(state.events.filter((event) => event.kind === "guide_delivery_attempts_exhausted"))
      .toHaveLength(1);
    expect(JSON.stringify(state.events)).not.toContain("PRIVATE CAP SNAPSHOT");
  });

  it.each([
    {
      label: "attempt cap",
      attempt: 3,
      terminalReason: { code: "attempts_exhausted" as const, maxAttempts: 3 },
      failureCode: "guide_unit_attempts_exhausted",
      eventKind: "guide_delivery_attempts_exhausted",
    },
    {
      label: "messaging window",
      attempt: 1,
      terminalReason: { code: "messaging_window_closed" as const },
      failureCode: "messaging_window_closed",
      eventKind: "guide_delivery_window_closed",
    },
  ])(
    "atomically checkpoints a terminal transient provider failure at the $label",
    async ({ attempt, terminalReason, failureCode, eventKind }) => {
      const fixture = await activeUnitAtAttempt(attempt, `PRIVATE ${failureCode} BODY`);
      const failedAt = new Date(startedAt.getTime() + 10_000);

      await expect(
        guideDeliveryRepository.markUnitFailed({
          deliveryId: fixture.delivery.id,
          unitId: fixture.begun.id,
          claimToken: fixture.claimed.claimToken,
          attempt: fixture.begun.attempts,
          failedAt,
          disposition: "transient",
          nextAttemptAt: null,
          terminalReason,
          error: { ...permanentError, httpStatus: 503, graphCode: 2 },
        }),
      ).resolves.toBe(true);

      const state = await storedState(fixture.delivery.id);
      expect(state.delivery).toMatchObject({
        status: "failed",
        failureCode,
        nextAttemptAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      });
      expect(state.delivery.units[0]).toMatchObject({
        status: "failed",
        failureDisposition: "transient",
        attempts: attempt,
        errorCategory: "graph_response",
        errorHttpStatus: 503,
        errorGraphCode: 2,
      });
      expect(state.events.filter((event) => event.kind === "guide_delivery_unit_failed"))
        .toHaveLength(1);
      expect(state.events.filter((event) => event.kind === eventKind)).toHaveLength(1);
      expect(state.events.find((event) => event.kind === eventKind)?.payload).toMatchObject(
        terminalReason.code === "attempts_exhausted"
          ? {
              deliveryId: fixture.delivery.id,
              conversationId,
              unitId: fixture.begun.id,
              position: 0,
              unitKind: "text",
              attempts: attempt,
              maxAttempts: terminalReason.maxAttempts,
              exhaustedAt: failedAt.toISOString(),
            }
          : {
              deliveryId: fixture.delivery.id,
              conversationId,
              unitId: fixture.begun.id,
              position: 0,
              unitKind: "text",
              attempt,
              at: failedAt.toISOString(),
            },
      );
      expect(JSON.stringify(state.events)).not.toContain(`PRIVATE ${failureCode} BODY`);
      expect(await claim(fixture.delivery.id, new Date(failedAt.getTime() + 120_000)))
        .toBeNull();
    },
  );

  it.each([
    {
      attempt: 3,
      terminalReason: { code: "attempts_exhausted" as const, maxAttempts: 3 },
    },
    {
      attempt: 1,
      terminalReason: { code: "messaging_window_closed" as const },
    },
  ])("fences $terminalReason.code checkpoints against stale token and attempt drift", async ({
    attempt,
    terminalReason,
  }) => {
    const fixture = await activeUnitAtAttempt(attempt);
    const before = await storedState(fixture.delivery.id);
    const input = {
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      claimToken: fixture.claimed.claimToken,
      attempt: fixture.begun.attempts,
      failedAt: new Date(startedAt.getTime() + 10_000),
      disposition: "transient" as const,
      nextAttemptAt: null,
      terminalReason,
      error: { ...permanentError, httpStatus: 503, graphCode: 2 },
    };

    await expect(
      guideDeliveryRepository.markUnitFailed({ ...input, claimToken: randomUUID() }),
    ).resolves.toBe(false);
    expect(await storedState(fixture.delivery.id)).toEqual(before);

    await expect(
      guideDeliveryRepository.markUnitFailed({ ...input, attempt: input.attempt + 1 }),
    ).resolves.toBe(false);
    expect(await storedState(fixture.delivery.id)).toEqual(before);
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

  it("fences beginUnit against stale tokens, wrong delivery state, and nonretryable units", async () => {
    const staleDelivery = await createDelivery();
    const staleClaim = await claim(staleDelivery.id);
    const staleBefore = await storedState(staleDelivery.id);
    await expect(
      guideDeliveryRepository.beginUnit({
        deliveryId: staleDelivery.id,
        claimToken: randomUUID(),
        now: startedAt,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
    expect(await storedState(staleDelivery.id)).toEqual(staleBefore);

    const wrongDelivery = await createDelivery();
    const wrongDeliveryClaim = await claim(wrongDelivery.id);
    await prisma.guideDelivery.update({
      where: { id: wrongDelivery.id },
      data: { status: "failed", failureCode: "guide_unit_permanent" },
    });
    const wrongDeliveryBefore = await storedState(wrongDelivery.id);
    await expect(
      guideDeliveryRepository.beginUnit({
        deliveryId: wrongDelivery.id,
        claimToken: wrongDeliveryClaim!.claimToken,
        now: startedAt,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
    expect(await storedState(wrongDelivery.id)).toEqual(wrongDeliveryBefore);

    const wrongUnit = await createDelivery();
    const wrongUnitClaim = await claim(wrongUnit.id);
    const wrongUnitRow = await prisma.guideDeliveryUnit.findFirstOrThrow({
      where: { deliveryId: wrongUnit.id },
    });
    await prisma.guideDeliveryUnit.update({
      where: { id: wrongUnitRow.id },
      data: { status: "uncertain", sendingAt: startedAt },
    });
    const wrongUnitBefore = await storedState(wrongUnit.id);
    await expect(
      guideDeliveryRepository.beginUnit({
        deliveryId: wrongUnit.id,
        claimToken: wrongUnitClaim!.claimToken,
        now: startedAt,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
    expect(await storedState(wrongUnit.id)).toEqual(wrongUnitBefore);

    expect(staleClaim).not.toBeNull();
  });

  it("fences failed checkpoints against token, ownership, delivery, unit, and attempt drift", async () => {
    const primary = await activeUnit();
    const other = await activeUnit("PRIVATE OTHER DELIVERY");
    const primaryBefore = await storedState(primary.delivery.id);
    const otherBefore = await storedState(other.delivery.id);

    const failedInput = {
      deliveryId: primary.delivery.id,
      unitId: primary.begun.id,
      claimToken: primary.claimed.claimToken,
      attempt: primary.begun.attempts,
      failedAt: new Date(startedAt.getTime() + 1_000),
      disposition: "permanent" as const,
      nextAttemptAt: null,
      terminalReason: null,
      error: permanentError,
    };

    await expect(
      guideDeliveryRepository.markUnitFailed({ ...failedInput, claimToken: randomUUID() }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);

    await expect(
      guideDeliveryRepository.markUnitFailed({ ...failedInput, unitId: other.begun.id }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);
    expect(await storedState(other.delivery.id)).toEqual(otherBefore);

    await expect(
      guideDeliveryRepository.markUnitFailed({
        ...failedInput,
        attempt: primary.begun.attempts + 1,
      }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);

    const wrongDelivery = await activeUnit();
    await prisma.guideDelivery.update({
      where: { id: wrongDelivery.delivery.id },
      data: { status: "needs_review" },
    });
    const wrongDeliveryBefore = await storedState(wrongDelivery.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitFailed({
        ...failedInput,
        deliveryId: wrongDelivery.delivery.id,
        unitId: wrongDelivery.begun.id,
        claimToken: wrongDelivery.claimed.claimToken,
        attempt: wrongDelivery.begun.attempts,
      }),
    ).resolves.toBe(false);
    expect(await storedState(wrongDelivery.delivery.id)).toEqual(wrongDeliveryBefore);

    const wrongUnit = await activeUnit();
    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: wrongUnit.delivery.id,
        unitId: wrongUnit.begun.id,
        claimToken: wrongUnit.claimed.claimToken,
        attempt: wrongUnit.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-wrong-unit-status",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(true);
    const wrongUnitBefore = await storedState(wrongUnit.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitFailed({
        ...failedInput,
        deliveryId: wrongUnit.delivery.id,
        unitId: wrongUnit.begun.id,
        claimToken: wrongUnit.claimed.claimToken,
        attempt: wrongUnit.begun.attempts,
      }),
    ).resolves.toBe(false);
    expect(await storedState(wrongUnit.delivery.id)).toEqual(wrongUnitBefore);
  });

  it("fences uncertain checkpoints against token, ownership, delivery, unit, and attempt drift", async () => {
    const primary = await activeUnit();
    const other = await activeUnit("PRIVATE OTHER UNCERTAIN DELIVERY");
    const primaryBefore = await storedState(primary.delivery.id);
    const otherBefore = await storedState(other.delivery.id);

    const uncertainInput = {
      deliveryId: primary.delivery.id,
      unitId: primary.begun.id,
      claimToken: primary.claimed.claimToken,
      attempt: primary.begun.attempts,
      uncertainAt: new Date(startedAt.getTime() + 1_000),
      error: uncertainError,
    };

    await expect(
      guideDeliveryRepository.markUnitUncertain({
        ...uncertainInput,
        claimToken: randomUUID(),
      }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);

    await expect(
      guideDeliveryRepository.markUnitUncertain({ ...uncertainInput, unitId: other.begun.id }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);
    expect(await storedState(other.delivery.id)).toEqual(otherBefore);

    await expect(
      guideDeliveryRepository.markUnitUncertain({
        ...uncertainInput,
        attempt: primary.begun.attempts + 1,
      }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);

    const wrongDelivery = await activeUnit();
    await prisma.guideDelivery.update({
      where: { id: wrongDelivery.delivery.id },
      data: { status: "failed", failureCode: "guide_unit_permanent" },
    });
    const wrongDeliveryBefore = await storedState(wrongDelivery.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitUncertain({
        ...uncertainInput,
        deliveryId: wrongDelivery.delivery.id,
        unitId: wrongDelivery.begun.id,
        claimToken: wrongDelivery.claimed.claimToken,
        attempt: wrongDelivery.begun.attempts,
      }),
    ).resolves.toBe(false);
    expect(await storedState(wrongDelivery.delivery.id)).toEqual(wrongDeliveryBefore);

    const wrongUnit = await activeUnit();
    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: wrongUnit.delivery.id,
        unitId: wrongUnit.begun.id,
        claimToken: wrongUnit.claimed.claimToken,
        attempt: wrongUnit.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-wrong-uncertain-status",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(true);
    const wrongUnitBefore = await storedState(wrongUnit.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitUncertain({
        ...uncertainInput,
        deliveryId: wrongUnit.delivery.id,
        unitId: wrongUnit.begun.id,
        claimToken: wrongUnit.claimed.claimToken,
        attempt: wrongUnit.begun.attempts,
      }),
    ).resolves.toBe(false);
    expect(await storedState(wrongUnit.delivery.id)).toEqual(wrongUnitBefore);
  });

  it("fences releaseClaim against stale tokens, wrong delivery state, and unsafe unit state", async () => {
    const staleDelivery = await createDelivery();
    const staleClaim = await claim(staleDelivery.id);
    const staleBefore = await storedState(staleDelivery.id);
    await expect(
      guideDeliveryRepository.releaseClaim({
        deliveryId: staleDelivery.id,
        claimToken: randomUUID(),
        now: startedAt,
      }),
    ).resolves.toBe(false);
    expect(await storedState(staleDelivery.id)).toEqual(staleBefore);

    const wrongDelivery = await createDelivery();
    const wrongDeliveryClaim = await claim(wrongDelivery.id);
    await prisma.guideDelivery.update({
      where: { id: wrongDelivery.id },
      data: { status: "failed", failureCode: "guide_unit_permanent" },
    });
    const wrongDeliveryBefore = await storedState(wrongDelivery.id);
    await expect(
      guideDeliveryRepository.releaseClaim({
        deliveryId: wrongDelivery.id,
        claimToken: wrongDeliveryClaim!.claimToken,
        now: startedAt,
      }),
    ).resolves.toBe(false);
    expect(await storedState(wrongDelivery.id)).toEqual(wrongDeliveryBefore);

    const sending = await activeUnit();
    const sendingBefore = await storedState(sending.delivery.id);
    await expect(
      guideDeliveryRepository.releaseClaim({
        deliveryId: sending.delivery.id,
        claimToken: sending.claimed.claimToken,
        now: startedAt,
      }),
    ).resolves.toBe(false);
    expect(await storedState(sending.delivery.id)).toEqual(sendingBefore);

    const uncertainDelivery = await createDelivery();
    const uncertainClaim = await claim(uncertainDelivery.id);
    const uncertainUnit = await prisma.guideDeliveryUnit.findFirstOrThrow({
      where: { deliveryId: uncertainDelivery.id },
    });
    await prisma.guideDeliveryUnit.update({
      where: { id: uncertainUnit.id },
      data: { status: "uncertain", sendingAt: startedAt },
    });
    const uncertainBefore = await storedState(uncertainDelivery.id);
    await expect(
      guideDeliveryRepository.releaseClaim({
        deliveryId: uncertainDelivery.id,
        claimToken: uncertainClaim!.claimToken,
        now: startedAt,
      }),
    ).resolves.toBe(false);
    expect(await storedState(uncertainDelivery.id)).toEqual(uncertainBefore);

    expect(staleClaim).not.toBeNull();
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

  it("fences sent checkpoints against cross-delivery ownership and wrong states", async () => {
    const primary = await activeUnit();
    const other = await activeUnit("PRIVATE OTHER SENT DELIVERY");
    const primaryBefore = await storedState(primary.delivery.id);
    const otherBefore = await storedState(other.delivery.id);

    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: primary.delivery.id,
        unitId: other.begun.id,
        claimToken: primary.claimed.claimToken,
        attempt: other.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-cross-delivery",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(primaryBefore);
    expect(await storedState(other.delivery.id)).toEqual(otherBefore);

    await prisma.guideDelivery.update({
      where: { id: primary.delivery.id },
      data: { status: "failed", failureCode: "guide_unit_permanent" },
    });
    const wrongDeliveryBefore = await storedState(primary.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: primary.delivery.id,
        unitId: primary.begun.id,
        claimToken: primary.claimed.claimToken,
        attempt: primary.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-wrong-delivery-status",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);
    expect(await storedState(primary.delivery.id)).toEqual(wrongDeliveryBefore);

    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: other.delivery.id,
        unitId: other.begun.id,
        claimToken: other.claimed.claimToken,
        attempt: other.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 1_000),
        providerMessageId: "mid-first-sent",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(true);
    const wrongUnitBefore = await storedState(other.delivery.id);
    await expect(
      guideDeliveryRepository.markUnitSent({
        deliveryId: other.delivery.id,
        unitId: other.begun.id,
        claimToken: other.claimed.claimToken,
        attempt: other.begun.attempts,
        sentAt: new Date(startedAt.getTime() + 2_000),
        providerMessageId: "mid-duplicate-sent",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);
    expect(await storedState(other.delivery.id)).toEqual(wrongUnitBefore);
  });

  it("persists a permanent failure with only allowlisted metadata and never makes it due", async () => {
    const fixture = await activeUnit("PRIVATE PERMANENT FAILURE BODY");
    const failedAt = new Date(startedAt.getTime() + 1_000);

    await expect(
      guideDeliveryRepository.markUnitFailed({
        deliveryId: fixture.delivery.id,
        unitId: fixture.begun.id,
        claimToken: fixture.claimed.claimToken,
        attempt: fixture.begun.attempts,
        failedAt,
        disposition: "permanent",
        nextAttemptAt: null,
        terminalReason: null,
        error: permanentError,
      }),
    ).resolves.toBe(true);

    const state = await storedState(fixture.delivery.id);
    expect(state.delivery).toMatchObject({
      status: "failed",
      failureCode: "guide_unit_permanent",
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    });
    expect(state.delivery.units[0]).toMatchObject({
      status: "failed",
      failureDisposition: "permanent",
      attempts: fixture.begun.attempts,
      errorCategory: permanentError.category,
      errorHttpStatus: permanentError.httpStatus,
      errorGraphCode: permanentError.graphCode,
      errorGraphSubcode: permanentError.graphSubcode,
      errorTraceId: permanentError.traceId,
      errorTransportCode: null,
    });
    const event = state.events.find((candidate) => candidate.kind === "guide_delivery_unit_failed");
    expect(event?.payload).toMatchObject({
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      position: 0,
      unitKind: "text",
      attempt: fixture.begun.attempts,
      disposition: "permanent",
      ...permanentError,
    });
    expect(JSON.stringify(event?.payload)).not.toContain("PRIVATE PERMANENT FAILURE BODY");
    await expect(claim(fixture.delivery.id, new Date(failedAt.getTime() + 120_000)))
      .resolves.toBeNull();
    const due = await guideDeliveryRepository.claimDueBatch({
      now: new Date(failedAt.getTime() + 120_000),
      claimExpiresAt: new Date(failedAt.getTime() + 180_000),
      limit: 10,
    });
    expect(due.map((row) => row.id)).not.toContain(fixture.delivery.id);
  });

  it("persists an uncertain outcome with only allowlisted metadata and never makes it due", async () => {
    const fixture = await activeUnit("PRIVATE UNCERTAIN FAILURE BODY");
    const uncertainAt = new Date(startedAt.getTime() + 1_000);

    await expect(
      guideDeliveryRepository.markUnitUncertain({
        deliveryId: fixture.delivery.id,
        unitId: fixture.begun.id,
        claimToken: fixture.claimed.claimToken,
        attempt: fixture.begun.attempts,
        uncertainAt,
        error: uncertainError,
      }),
    ).resolves.toBe(true);

    const state = await storedState(fixture.delivery.id);
    expect(state.delivery).toMatchObject({
      status: "needs_review",
      failureCode: "guide_unit_uncertain",
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    });
    expect(state.delivery.units[0]).toMatchObject({
      status: "uncertain",
      failureDisposition: null,
      attempts: fixture.begun.attempts,
      errorCategory: uncertainError.category,
      errorHttpStatus: null,
      errorGraphCode: null,
      errorGraphSubcode: null,
      errorTraceId: null,
      errorTransportCode: uncertainError.transportCode,
    });
    const event = state.events.find(
      (candidate) => candidate.kind === "guide_delivery_unit_uncertain",
    );
    expect(event?.payload).toMatchObject({
      deliveryId: fixture.delivery.id,
      unitId: fixture.begun.id,
      position: 0,
      unitKind: "text",
      attempt: fixture.begun.attempts,
      ...uncertainError,
    });
    expect(JSON.stringify(event?.payload)).not.toContain("PRIVATE UNCERTAIN FAILURE BODY");
    await expect(claim(fixture.delivery.id, new Date(uncertainAt.getTime() + 120_000)))
      .resolves.toBeNull();
    const due = await guideDeliveryRepository.claimDueBatch({
      now: new Date(uncertainAt.getTime() + 120_000),
      claimExpiresAt: new Date(uncertainAt.getTime() + 180_000),
      limit: 10,
    });
    expect(due.map((row) => row.id)).not.toContain(fixture.delivery.id);
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

  it("owner-confirms an uncertain unit atomically and permits completion after window close", async () => {
    const fixture = await needsReviewDelivery(1);
    const confirmedAt = afterWindow;

    const result = await guideDeliveryRepository.ownerConfirmUnitDelivered({
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: confirmedAt,
    });
    const state = await storedState(fixture.delivery.id);

    expect(result).toEqual({ ok: true, directive: "finalize", idempotent: false });
    expect(state.delivery).toMatchObject({ status: "planned", failureCode: null });
    expect(state.delivery.units[0]).toMatchObject({
      status: "sent",
      sentAt: confirmedAt,
      ownerConfirmedAt: confirmedAt,
      providerMessageId: null,
    });
    const ownerEvents = state.events.filter((event) => event.kind === "guide_delivery_owner_action");
    expect(ownerEvents).toHaveLength(1);
    expect(ownerEvents[0]!.payload).toEqual({
      actor: "owner@example.com",
      action: "confirm_delivered",
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      timestamp: confirmedAt.toISOString(),
    });
    expect(JSON.stringify(ownerEvents)).not.toContain("PRIVATE REVIEW");

    const completionClaim = await claim(fixture.delivery.id, confirmedAt);
    expect(completionClaim).toMatchObject({ status: "sending" });
    expect(completionClaim!.units.map((row) => row.status)).toEqual(["sent"]);
  });

  it("owner confirmation closes an expired delivery when unsent work remains", async () => {
    const fixture = await needsReviewDelivery(2);
    const extraPending = await prisma.guideDeliveryUnit.create({
      data: { ...unit(2, "PRIVATE REMAINING"), deliveryId: fixture.delivery.id },
    });

    const result = await guideDeliveryRepository.ownerConfirmUnitDelivered({
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: afterWindow,
    });
    const state = await storedState(fixture.delivery.id);

    expect(result).toEqual({ ok: true, directive: "none", idempotent: false });
    expect(state.delivery).toMatchObject({
      status: "failed",
      failureCode: "messaging_window_closed",
      claimToken: null,
    });
    expect(state.delivery.units.find((row) => row.id === extraPending.id)?.status).toBe("pending");
  });

  it("authorizes exactly one retry and beginUnit atomically consumes it without resetting sent units", async () => {
    const fixture = await needsReviewDelivery(2);
    await prisma.guideDeliveryUnit.update({
      where: { id: fixture.uncertain.id },
      data: { attempts: 3 },
    });
    const authorizedAt = new Date(startedAt.getTime() + 1_000);

    const result = await guideDeliveryRepository.ownerRetryUncertainUnit({
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: authorizedAt,
    });
    const beforeClaim = await storedState(fixture.delivery.id);

    expect(result).toEqual({ ok: true, directive: "resume", idempotent: false });
    expect(beforeClaim.delivery.units[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(beforeClaim.delivery.units[1]).toMatchObject({
      status: "failed",
      failureDisposition: "transient",
      attempts: 3,
      ownerRetryAuthorizedAt: authorizedAt,
      ownerRetryConsumedAt: null,
    });
    const retryClaim = await claim(fixture.delivery.id, authorizedAt);
    const begun = await guideDeliveryRepository.beginUnit({
      deliveryId: fixture.delivery.id,
      claimToken: retryClaim!.claimToken,
      now: new Date(authorizedAt.getTime() + 1),
      maxAttempts: 3,
    });
    expect(begun).toMatchObject({
      id: fixture.uncertain.id,
      status: "sending",
      attempts: 4,
      ownerRetryAuthorizedAt: authorizedAt,
      ownerRetryConsumedAt: new Date(authorizedAt.getTime() + 1),
    });
    await expect(guideDeliveryRepository.beginUnit({
      deliveryId: fixture.delivery.id,
      claimToken: retryClaim!.claimToken,
      now: new Date(authorizedAt.getTime() + 2),
      maxAttempts: 3,
    })).resolves.toBeNull();
  });

  it("rejects retry at window equality with no state or event drift", async () => {
    const fixture = await needsReviewDelivery(1);
    const before = await storedState(fixture.delivery.id);

    const result = await guideDeliveryRepository.ownerRetryUncertainUnit({
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: sendWindowExpiresAt,
    });
    const after = await storedState(fixture.delivery.id);

    expect(result).toEqual({ ok: false, error: "messaging_window_closed" });
    expect(after.delivery).toEqual(before.delivery);
    expect(after.events).toEqual(before.events);
  });

  it("serializes concurrent confirmations and creates one owner audit event", async () => {
    const fixture = await needsReviewDelivery(1);
    const input = {
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: new Date(startedAt.getTime() + 1_000),
    };

    const outcomes = await Promise.all([
      guideDeliveryRepository.ownerConfirmUnitDelivered(input),
      guideDeliveryRepository.ownerConfirmUnitDelivered(input),
    ]);
    const events = await eventsFor(fixture.delivery.id);

    expect(outcomes).toContainEqual({ ok: true, directive: "finalize", idempotent: false });
    expect(outcomes).toContainEqual({ ok: true, directive: "none", idempotent: true });
    expect(events.filter((event) => event.kind === "guide_delivery_owner_action")).toHaveLength(1);
  });

  it("cancels exactly once, including after window close, but never overrides completed or active work", async () => {
    const review = await needsReviewDelivery(1);
    const cancelAt = afterWindow;
    const [left, right] = await Promise.all([
      guideDeliveryRepository.ownerCancelDelivery({
        deliveryId: review.delivery.id,
        actor: "owner@example.com",
        now: cancelAt,
      }),
      guideDeliveryRepository.ownerCancelDelivery({
        deliveryId: review.delivery.id,
        actor: "owner@example.com",
        now: cancelAt,
      }),
    ]);
    expect([left, right]).toContainEqual({ ok: true, directive: "none", idempotent: false });
    expect([left, right]).toContainEqual({ ok: true, directive: "none", idempotent: true });
    const cancelled = await storedState(review.delivery.id);
    expect(cancelled.delivery).toMatchObject({ status: "cancelled", cancelledAt: cancelAt });
    expect(cancelled.events.filter((event) => event.kind === "guide_delivery_owner_action"))
      .toHaveLength(1);

    const active = await createDelivery();
    await claim(active.id);
    await expect(guideDeliveryRepository.ownerCancelDelivery({
      deliveryId: active.id,
      actor: "owner@example.com",
      now: cancelAt,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });

    const completedId = await allSentUnclaimed();
    const completedClaim = await claim(completedId, new Date(startedAt.getTime() + 3_000));
    await guideDeliveryRepository.finalizeCompleted({
      deliveryId: completedId,
      claimToken: completedClaim!.claimToken,
      completedAt: startedAt,
    });
    await expect(guideDeliveryRepository.ownerCancelDelivery({
      deliveryId: completedId,
      actor: "owner@example.com",
      now: cancelAt,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });
  });

  it("fences missing units and stale delivery states without partial audit", async () => {
    const fixture = await needsReviewDelivery(2);
    const before = await eventsFor(fixture.delivery.id);
    await expect(guideDeliveryRepository.ownerConfirmUnitDelivered({
      deliveryId: fixture.delivery.id,
      unitId: randomUUID(),
      actor: "owner@example.com",
      now: startedAt,
    })).resolves.toEqual({ ok: false, error: "unit_not_found" });
    expect(await eventsFor(fixture.delivery.id)).toEqual(before);

    const alreadySent = await prisma.guideDeliveryUnit.findFirstOrThrow({
      where: { deliveryId: fixture.delivery.id, status: "sent" },
    });
    await expect(guideDeliveryRepository.ownerConfirmUnitDelivered({
      deliveryId: fixture.delivery.id,
      unitId: alreadySent.id,
      actor: "owner@example.com",
      now: startedAt,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });
    expect(await eventsFor(fixture.delivery.id)).toEqual(before);

    await prisma.guideDelivery.update({
      where: { id: fixture.delivery.id },
      data: { status: "failed", failureCode: "guide_unit_permanent" },
    });
    await expect(guideDeliveryRepository.ownerRetryUncertainUnit({
      deliveryId: fixture.delivery.id,
      unitId: fixture.uncertain.id,
      actor: "owner@example.com",
      now: startedAt,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });
    expect((await eventsFor(fixture.delivery.id)).filter((event) => event.kind === "guide_delivery_owner_action"))
      .toHaveLength(0);
  });

  it("refuses every owner transition when any unit is still at the provider boundary", async () => {
    const fixture = await needsReviewDelivery(1);
    const active = await prisma.guideDeliveryUnit.create({
      data: {
        ...unit(1, "PRIVATE ACTIVE SENDER"),
        deliveryId: fixture.delivery.id,
        status: "sending",
        sendingAt: startedAt,
        attempts: 1,
      },
    });
    const ownerInput = {
      deliveryId: fixture.delivery.id,
      actor: "owner@example.com",
      now: new Date(startedAt.getTime() + 1_000),
    };

    await expect(guideDeliveryRepository.ownerConfirmUnitDelivered({
      ...ownerInput,
      unitId: fixture.uncertain.id,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });
    await expect(guideDeliveryRepository.ownerRetryUncertainUnit({
      ...ownerInput,
      unitId: fixture.uncertain.id,
    })).resolves.toEqual({ ok: false, error: "delivery_state_changed" });
    await expect(guideDeliveryRepository.ownerCancelDelivery(ownerInput))
      .resolves.toEqual({ ok: false, error: "delivery_state_changed" });

    const stored = await storedState(fixture.delivery.id);
    expect(stored.delivery.status).toBe("needs_review");
    expect(stored.delivery.units.find((candidate) => candidate.id === active.id)?.status)
      .toBe("sending");
    expect(stored.events.filter((event) => event.kind === "guide_delivery_owner_action"))
      .toHaveLength(0);
  });
});
