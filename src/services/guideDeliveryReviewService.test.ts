import { randomUUID } from "node:crypto";
import { PrismaClient, type GuideDeliveryUnitStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGuideDeliveryRepository } from "./guideDeliveryRepository.js";
import {
  GuideDeliveryReviewError,
  createGuideDeliveryReviewService,
  type GuideDeliveryReviewDispatch,
} from "./guideDeliveryReviewService.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const NOW = new Date("2026-08-17T12:00:00.000Z");
const OWNER = "owner@example.com";
const PRIVATE_TEXT = "PRIVATE-TASK10-GUIDE-SNAPSHOT";
const PRIVATE_MEDIA_URL = "https://private.example.test/task10-guide.jpg?token=secret";
const PRIVATE_TRACE = "private_task10_trace";

type UnitFixture = {
  id: string;
  position: number;
  status: GuideDeliveryUnitStatus;
};

type DeliveryFixture = {
  conversationId: string;
  deliveryId: string;
  resourceId: string;
  units: UnitFixture[];
};

let prisma: PrismaClient;
const fixtureResourceIds = new Set<string>();

async function createDelivery(input: {
  statuses?: GuideDeliveryUnitStatus[];
  sendWindowExpiresAt?: Date;
  deliveryStatus?: "needs_review" | "failed" | "completed";
} = {}): Promise<DeliveryFixture> {
  const statuses = input.statuses ?? ["sent", "uncertain", "pending"];
  const resourceId = randomUUID();
  const keywordId = randomUUID();
  const conversationId = randomUUID();
  const deliveryId = randomUUID();
  fixtureResourceIds.add(resourceId);

  await prisma.resource.create({ data: { id: resourceId, name: `Task 10 ${resourceId}` } });
  await prisma.keyword.create({
    data: {
      id: keywordId,
      keyword: `task10-${randomUUID()}`,
      resourceId,
      publicReply: "reply",
      gateMessage: "gate",
      active: false,
    },
  });
  await prisma.conversation.create({
    data: { id: conversationId, igUserId: `task10-${randomUUID()}`, keywordId },
  });
  await prisma.guideDelivery.create({
    data: {
      id: deliveryId,
      conversationId,
      resourceId,
      triggerKind: "inbound_reply",
      triggerId: randomUUID(),
      triggeredAt: new Date(NOW.getTime() - 60_000),
      sendWindowExpiresAt:
        input.sendWindowExpiresAt ?? new Date(NOW.getTime() + 60 * 60 * 1_000),
      followerAtTrigger: true,
      status: input.deliveryStatus ?? "needs_review",
      startedAt: new Date(NOW.getTime() - 30_000),
    },
  });

  const units = statuses.map((status, position) => ({
    id: randomUUID(),
    position,
    status,
  }));
  for (const unit of units) {
    const sent = unit.status === "sent";
    const providerBoundary = ["sent", "sending", "retryable", "failed", "uncertain"].includes(
      unit.status,
    );
    await prisma.guideDeliveryUnit.create({
      data: {
        id: unit.id,
        deliveryId,
        position: unit.position,
        origin: "resource_step",
        kind: unit.position === 2 ? "image" : "text",
        textSnapshot: unit.position === 2 ? null : PRIVATE_TEXT,
        mediaUrlSnapshot: unit.position === 2 ? PRIVATE_MEDIA_URL : null,
        contentFingerprint: String(unit.position + 1).repeat(64),
        status: unit.status,
        attempts: providerBoundary ? 1 : 0,
        sendingAt: providerBoundary ? new Date(NOW.getTime() - 15_000) : null,
        sentAt: sent ? new Date(NOW.getTime() - 10_000) : null,
        providerMessageId: sent ? `provider-${unit.position}` : null,
        errorCategory: unit.status === "uncertain" ? "transport" : null,
        errorTraceId: unit.status === "uncertain" ? PRIVATE_TRACE : null,
      },
    });
  }
  return { conversationId, deliveryId, resourceId, units };
}

async function ownerEvents(deliveryId: string) {
  return prisma.eventLog.findMany({
    where: { kind: "guide_delivery_owner_action", payload: { path: ["deliveryId"], equals: deliveryId } },
    orderBy: { createdAt: "asc" },
  });
}

function expectReviewError(code: string) {
  return expect.objectContaining({ name: "GuideDeliveryReviewError", code });
}

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(LOOPBACK_HOSTS).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (!databaseUrl || fixtureResourceIds.size === 0) return;
  const resourceIds = [...fixtureResourceIds];
  await prisma.$executeRaw`
    DELETE FROM "event_log"
    WHERE "payload"->>'resourceId' = ANY(${resourceIds}::text[])
  `;
  await prisma.guideDelivery.deleteMany({ where: { resourceId: { in: resourceIds } } });
  // Attempts reference the conversation with ON DELETE RESTRICT, and their action tokens
  // reference the attempt the same way, so both have to go before the conversation does.
  await prisma.guideActionToken.deleteMany({
    where: { attempt: { resourceId: { in: resourceIds } } },
  });
  await prisma.guideAccessAttempt.deleteMany({ where: { resourceId: { in: resourceIds } } });
  await prisma.conversation.deleteMany({ where: { keyword: { resourceId: { in: resourceIds } } } });
  await prisma.keyword.deleteMany({ where: { resourceId: { in: resourceIds } } });
  await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
  fixtureResourceIds.clear();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase("guide delivery owner review PostgreSQL contract", () => {
  it("confirms only an uncertain unit on a needs-review delivery and audits after the lock-protected change", async () => {
    const fixture = await createDelivery();
    const dispatches: GuideDeliveryReviewDispatch[] = [];
    const service = createGuideDeliveryReviewService({
      database: prisma,
      dispatchAfterCommit: async (dispatch) => {
        const [delivery, events] = await Promise.all([
          prisma.guideDelivery.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
          ownerEvents(fixture.deliveryId),
        ]);
        expect(delivery.status).toBe("planned");
        expect(events).toHaveLength(1);
        dispatches.push(dispatch);
      },
    });

    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        now: NOW,
      }),
    ).resolves.toEqual({ status: "processing_started" });

    const confirmed = await prisma.guideDeliveryUnit.findUniqueOrThrow({
      where: { id: fixture.units[1]!.id },
    });
    expect(confirmed).toMatchObject({ status: "sent", sentAt: NOW, ownerConfirmedAt: NOW });
    expect(dispatches).toEqual([{ deliveryId: fixture.deliveryId, directive: "resume", now: NOW }]);

    const events = await ownerEvents(fixture.deliveryId);
    expect(events.map((event) => event.payload)).toEqual([
      {
        actor: OWNER,
        action: "confirm_delivered",
        deliveryId: fixture.deliveryId,
        resourceId: fixture.resourceId,
        unitId: fixture.units[1]!.id,
        at: NOW.toISOString(),
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PRIVATE_TEXT);
    expect(serialized).not.toContain(PRIVATE_MEDIA_URL);
    expect(serialized).not.toContain(PRIVATE_TRACE);
  });

  it("finalizes an all-sent delivery after the window closes because no provider call remains", async () => {
    const fixture = await createDelivery({
      statuses: ["sent", "uncertain"],
      sendWindowExpiresAt: new Date(NOW.getTime() - 1),
    });
    const dispatchAfterCommit = vi.fn(async (dispatch: GuideDeliveryReviewDispatch) => {
      const units = await prisma.guideDeliveryUnit.findMany({ where: { deliveryId: fixture.deliveryId } });
      expect(units.every((unit) => unit.status === "sent")).toBe(true);
      expect(dispatch.directive).toBe("finalize");
    });
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit });

    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        now: NOW,
      }),
    ).resolves.toEqual({ status: "processing_started" });
    expect(dispatchAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("records a closed window without dispatch when confirmation leaves an unsent remainder", async () => {
    const fixture = await createDelivery({
      sendWindowExpiresAt: new Date(NOW.getTime() - 1),
    });
    const dispatchAfterCommit = vi.fn();
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit });

    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        now: NOW,
      }),
    ).resolves.toEqual({ status: "accepted" });

    expect(dispatchAfterCommit).not.toHaveBeenCalled();
    await expect(
      prisma.guideDelivery.findUnique({ where: { id: fixture.deliveryId } }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "messaging_window_closed",
      nextAttemptAt: null,
    });
    const windowEvent = await prisma.eventLog.findFirstOrThrow({
      where: {
        kind: "guide_delivery_window_closed",
        payload: { path: ["deliveryId"], equals: fixture.deliveryId },
      },
    });
    expect(JSON.stringify(windowEvent.payload)).not.toContain(PRIVATE_TEXT);
  });

  it("requires literal duplicate-risk acknowledgement", async () => {
    const open = await createDelivery();
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit: vi.fn() });

    await expect(
      service.retryUncertainUnit({
        deliveryId: open.deliveryId,
        unitId: open.units[1]!.id,
        actor: OWNER,
        acknowledgeDuplicateRisk: false,
        now: NOW,
      }),
    ).rejects.toEqual(expectReviewError("duplicate_risk_acknowledgement_required"));
  });

  it("durably records one safe retry-skipped action before concurrent expired retries return window closed", async () => {
    const fixture = await createDelivery({ sendWindowExpiresAt: new Date(NOW.getTime() - 1) });
    const dispatchAfterCommit = vi.fn();
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit });
    const input = {
      deliveryId: fixture.deliveryId,
      unitId: fixture.units[1]!.id,
      actor: OWNER,
      acknowledgeDuplicateRisk: true as const,
      now: NOW,
    };

    const results = await Promise.allSettled([
      service.retryUncertainUnit(input),
      service.retryUncertainUnit(input),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: expectReviewError("messaging_window_closed"),
      });
    }
    expect(dispatchAfterCommit).not.toHaveBeenCalled();
    await expect(
      prisma.guideDelivery.findUnique({ where: { id: fixture.deliveryId } }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "messaging_window_closed",
      nextAttemptAt: null,
      claimToken: null,
    });
    await expect(
      prisma.guideDeliveryUnit.findUnique({ where: { id: fixture.units[1]!.id } }),
    ).resolves.toMatchObject({
      status: "uncertain",
      ownerRetryAuthorizedAt: null,
      ownerRetryConsumedAt: null,
    });

    const events = await ownerEvents(fixture.deliveryId);
    expect(events.map((event) => event.payload)).toEqual([
      {
        actor: OWNER,
        action: "retry_skipped_window_closed",
        deliveryId: fixture.deliveryId,
        resourceId: fixture.resourceId,
        unitId: fixture.units[1]!.id,
        at: NOW.toISOString(),
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PRIVATE_TEXT);
    expect(serialized).not.toContain(PRIVATE_MEDIA_URL);
    expect(serialized).not.toContain(PRIVATE_TRACE);
  });

  it("authorizes only the uncertain unit and atomically consumes one retry before any provider work", async () => {
    const fixture = await createDelivery({ statuses: ["sent", "uncertain", "pending"] });
    await prisma.guideDeliveryUnit.update({
      where: { id: fixture.units[1]!.id },
      data: { attempts: 3 },
    });
    const repository = createGuideDeliveryRepository({ database: prisma, maxAttempts: 3 });
    const begunUnits: string[] = [];
    const service = createGuideDeliveryReviewService({
      database: prisma,
      dispatchAfterCommit: async ({ deliveryId, now }) => {
        const claimed = await repository.claimById({
          deliveryId,
          now,
          claimExpiresAt: new Date(now.getTime() + 60_000),
        });
        expect(claimed).not.toBeNull();
        const begun = await repository.beginUnit({
          deliveryId,
          claimToken: claimed!.claimToken,
          now,
          claimExpiresAt: new Date(now.getTime() + 60_000),
        });
        expect(begun).not.toBeNull();
        begunUnits.push(begun!.id);
      },
    });

    await expect(
      service.retryUncertainUnit({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        acknowledgeDuplicateRisk: true,
        now: NOW,
      }),
    ).resolves.toEqual({ status: "processing_started" });

    expect(begunUnits).toEqual([fixture.units[1]!.id]);
    const units = await prisma.guideDeliveryUnit.findMany({
      where: { deliveryId: fixture.deliveryId },
      orderBy: { position: "asc" },
    });
    expect(units[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(units[1]).toMatchObject({
      status: "sending",
      attempts: 4,
      ownerRetryAuthorizedAt: NOW,
      ownerRetryConsumedAt: NOW,
    });
    expect(units[2]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("allows one winner across concurrent retry actions", async () => {
    const fixture = await createDelivery();
    const dispatchAfterCommit = vi.fn();
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit });
    const input = {
      deliveryId: fixture.deliveryId,
      unitId: fixture.units[1]!.id,
      actor: OWNER,
      acknowledgeDuplicateRisk: true as const,
      now: NOW,
    };

    const results = await Promise.allSettled([
      service.retryUncertainUnit(input),
      service.retryUncertainUnit(input),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expectReviewError("delivery_state_changed"),
    });
    expect(dispatchAfterCommit).toHaveBeenCalledTimes(1);
    await expect(ownerEvents(fixture.deliveryId)).resolves.toHaveLength(1);
  });

  it("cancels every non-sent unit while preserving sent evidence and conversation state, idempotently", async () => {
    const fixture = await createDelivery({
      statuses: ["sent", "uncertain", "retryable", "failed", "pending"],
      sendWindowExpiresAt: new Date(NOW.getTime() - 1),
    });
    const dispatchAfterCommit = vi.fn();
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit });

    await expect(
      service.cancelGuideDelivery({ deliveryId: fixture.deliveryId, actor: OWNER, now: NOW }),
    ).resolves.toEqual({ status: "accepted" });
    await expect(
      service.cancelGuideDelivery({ deliveryId: fixture.deliveryId, actor: OWNER, now: NOW }),
    ).resolves.toEqual({ status: "accepted" });

    const [delivery, units, conversation, events] = await Promise.all([
      prisma.guideDelivery.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.guideDeliveryUnit.findMany({
        where: { deliveryId: fixture.deliveryId },
        orderBy: { position: "asc" },
      }),
      prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversationId } }),
      ownerEvents(fixture.deliveryId),
    ]);
    expect(delivery).toMatchObject({ status: "cancelled", cancelledAt: NOW });
    expect(units.map((unit) => unit.status)).toEqual([
      "sent",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(units[0]).toMatchObject({
      providerMessageId: "provider-0",
      sentAt: new Date(NOW.getTime() - 10_000),
    });
    expect(conversation).toMatchObject({ state: "awaiting_done", completedAt: null });
    expect(events).toHaveLength(1);
    expect(dispatchAfterCommit).not.toHaveBeenCalled();
  });

  it("uses stable missing and changed-state errors without leaking row data", async () => {
    const fixture = await createDelivery({ deliveryStatus: "failed" });
    const service = createGuideDeliveryReviewService({ database: prisma, dispatchAfterCommit: vi.fn() });

    await expect(
      service.confirmUnitDelivered({
        deliveryId: randomUUID(),
        unitId: randomUUID(),
        actor: OWNER,
        now: NOW,
      }),
    ).rejects.toEqual(expectReviewError("delivery_not_found"));
    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: randomUUID(),
        actor: OWNER,
        now: NOW,
      }),
    ).rejects.toEqual(expectReviewError("unit_not_found"));
    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(GuideDeliveryReviewError);
    await expect(
      service.confirmUnitDelivered({
        deliveryId: fixture.deliveryId,
        unitId: fixture.units[1]!.id,
        actor: OWNER,
        now: NOW,
      }),
    ).rejects.toEqual(expectReviewError("delivery_state_changed"));
  });
});

// Task 7 decision, pinned so a later reader does not "fix" it.
//
// The spec requires a fresh live `true` for every new automated guide send,
// "including an explicit redelivery" — where explicit means the PARENT asked
// again. That path runs through the direct-DM keyword branch and is gated there.
//
// Owner review is a different thing: it is the human escape hatch that exists
// precisely because the ledger refuses to auto-retry an uncertain provider
// outcome. The delivery it retries was already authorized by a fresh check when
// it started, and the operator is making an explicit-risk decision. Gating that
// click on a live Graph call would let a Meta outage strand a stuck delivery,
// inverting the hatch's purpose.
describe("owner review authorization boundary", () => {
  it("performs no follow check and cannot start a new delivery", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./guideDeliveryReviewService.ts", import.meta.url), "utf8"),
    );

    for (const disqualified of [
      "resolveFollowStatusFresh",
      "getFollowState",
      "isFollower",
      "deliverGuideForTrigger",
    ]) {
      expect(source).not.toContain(disqualified);
    }
  });
});

// Parent-delivery Task 5, review round 1. `delivering` is an ACTIVE guide-access attempt
// state, so a cancelled delivery that left the attempt untouched would block the parent's
// next request for the rest of the messaging window. Round 1 caught that the first fix
// picked `needs_review`, which is ALSO active — the block survived the fix.
describeWithDatabase("cancel releases the guide access attempt", () => {
  async function attemptFor(fixture: DeliveryFixture, state: "delivering" | "needs_review") {
    const attemptId = randomUUID();
    await prisma.guideAccessAttempt.create({
      data: {
        id: attemptId,
        conversationId: fixture.conversationId,
        resourceId: fixture.resourceId,
        state,
        // Any attempt that reached `delivering` did so by confirming a live follow.
        // `guide_access_attempt_state_follow_result_check` enforces exactly that pairing,
        // so this is not a fixture convenience — it is the only row the schema allows.
        lastFollowResult: "follower",
        createdAt: NOW,
        messagingWindowExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1_000),
      },
    });
    return attemptId;
  }

  it("moves a delivering attempt to a terminal state so the parent can ask again", async () => {
    const fixture = await createDelivery();
    const attemptId = await attemptFor(fixture, "delivering");
    const service = createGuideDeliveryReviewService({ database: prisma });

    await expect(
      service.cancelGuideDelivery({ deliveryId: fixture.deliveryId, actor: OWNER, now: NOW }),
    ).resolves.toEqual({ status: "accepted" });

    const attempt = await prisma.guideAccessAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.state).toBe("expired");
    // The behavioural claim, not just the state name: nothing active is left on this
    // conversation, which is exactly what `createOrLoadAttempt` looks for before it
    // decides whether the parent is already mid-flight.
    await expect(
      prisma.guideAccessAttempt.count({
        where: {
          conversationId: fixture.conversationId,
          state: {
            in: ["awaiting_request", "checking_follow", "awaiting_follow", "delivering", "needs_review"],
          },
        },
      }),
    ).resolves.toBe(0);
  });

  it("leaves an attempt that already settled alone", async () => {
    const fixture = await createDelivery();
    const attemptId = await attemptFor(fixture, "needs_review");
    const service = createGuideDeliveryReviewService({ database: prisma });

    await service.cancelGuideDelivery({ deliveryId: fixture.deliveryId, actor: OWNER, now: NOW });

    // Fenced on `delivering`, so a cancel cannot overwrite a state the action service
    // already decided — including one an earlier cancel produced.
    const attempt = await prisma.guideAccessAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.state).toBe("needs_review");
  });

  it("does not invent an attempt for a delivery that never had one", async () => {
    const fixture = await createDelivery();
    const service = createGuideDeliveryReviewService({ database: prisma });

    await expect(
      service.cancelGuideDelivery({ deliveryId: fixture.deliveryId, actor: OWNER, now: NOW }),
    ).resolves.toEqual({ status: "accepted" });

    await expect(
      prisma.guideAccessAttempt.count({ where: { conversationId: fixture.conversationId } }),
    ).resolves.toBe(0);
  });
});
