import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// QA-15. Reconciliation decides which conversation a journey is anchored to, and the
// selector joins on exactly that row — so the choice decides which comment a historical
// campaign would publicly reply to, and whether the journey is eligible at all.
//
// Its gate evidence read only `gate_queue.status = 'sent'`. That queue is a FAILURE
// queue: a gate Meta accepted on the first attempt leaves no row in it. Measured against
// production: 3,438 of 4,543 conversations with a confirmed gate were invisible to this
// query, and 30 canonical choices are wrong as a result.
//
// Real Postgres, because every one of these is a WHERE clause and a mocked client would
// return whatever the test itself wrote.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let repo: typeof import("./journeyReconciliationRepository.js");

type Fixture = { resourceId: string; keywordId: string; igUserId: string };
let fx: Fixture;

const CREATED_AT = new Date("2026-06-01T10:00:00Z");

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = await import("./journeyReconciliationRepository.js");

  fx = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `recon-${randomUUID()}`,
  };
  await prisma.resource.create({ data: { id: fx.resourceId, name: "reconciliation contract" } });
  await prisma.keyword.create({
    data: {
      id: fx.keywordId,
      keyword: `RECON-${fx.keywordId}`,
      resourceId: fx.resourceId,
      publicReply: "x",
      gateMessage: "y",
    },
  });
});

async function wipe(): Promise<void> {
  await prisma.gateQueue.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyTrigger.deleteMany({
    where: { intent: { igUserId: { startsWith: fx.igUserId } } },
  });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
}

beforeEach(async () => {
  if (!prisma) return;
  await wipe();
});

afterAll(async () => {
  if (!prisma) return;
  await wipe();
  await prisma.keyword.deleteMany({ where: { id: fx.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

/** One conversation for this fixture's person and keyword. */
async function seedConversation(opts: {
  gate?: "event" | "queue" | "none";
  createdAt?: Date;
  person?: string;
}): Promise<string> {
  const igUserId = opts.person ?? `${fx.igUserId}-${randomUUID()}`;
  await prisma.igUser.upsert({ where: { id: igUserId }, create: { id: igUserId }, update: {} });

  const convo = await prisma.conversation.create({
    data: {
      igUserId,
      keywordId: fx.keywordId,
      state: "awaiting_done",
      createdAt: opts.createdAt ?? CREATED_AT,
    },
  });

  if (opts.gate === "event") {
    // The authoritative record of a gate Meta accepted. A first-attempt success writes
    // ONLY this — no gate_queue row is ever created.
    await prisma.eventLog.create({
      data: { kind: "dm_sent", payload: { conversationId: convo.id }, createdAt: CREATED_AT },
    });
  }
  if (opts.gate === "queue") {
    await prisma.gateQueue.create({
      data: {
        igUserId,
        conversationId: convo.id,
        commentId: `recon-c-${randomUUID()}`,
        gateMessage: "follow, then reply DONE",
        commentAt: CREATED_AT,
        nextAttemptAt: CREATED_AT,
        status: "sent",
      },
    });
  }

  return convo.id;
}

describeWithLocalDatabase("reconciliation sees every accepted gate", () => {
  // THE defect. A gate that succeeded first try leaves no queue row, so the tier-2
  // signal was blind to it and the journey lost canonical precedence to an earlier one
  // that never delivered anything.
  it("counts a first-attempt gate that only wrote an event", async () => {
    const id = await seedConversation({ gate: "event" });

    const rows = await repo.loadReconciliationRows();

    expect(rows.find((r) => r.id === id)?.hasSentGate).toBe(true);
  });

  // The retry path still counts, unchanged.
  it("still counts a gate accepted after a retry", async () => {
    const id = await seedConversation({ gate: "queue" });

    const rows = await repo.loadReconciliationRows();

    expect(rows.find((r) => r.id === id)?.hasSentGate).toBe(true);
  });

  // And a journey with no accepted gate must stay false, or the signal means nothing.
  it("reports no gate when neither record exists", async () => {
    const id = await seedConversation({ gate: "none" });

    const rows = await repo.loadReconciliationRows();

    expect(rows.find((r) => r.id === id)?.hasSentGate).toBe(false);
  });
});

describeWithLocalDatabase("a reconciled window is written atomically", () => {
  // The write was four-plus separate statements. A failure part-way left an intent
  // created with some conversations repointed and the rest raw — and a re-run then read
  // that half-written window as its own starting state, so the second interpretation
  // could differ from the first.
  it("writes no intent at all when repointing a conversation fails", async () => {
    const person = `${fx.igUserId}-${randomUUID()}`;
    const canonical = await seedConversation({ gate: "event", person });

    await expect(
      repo.applyReconciledWindow({
        igUserId: person,
        keywordId: fx.keywordId,
        canonicalId: canonical,
        windowStartedAt: CREATED_AT,
        lastTriggerAt: CREATED_AT,
        windowExpiresAt: new Date(CREATED_AT.getTime() + 48 * 3600_000),
        completedAt: null,
        choice: "confirmed_gate",
        // The second alias does not exist, so the final update fails after the intent
        // and the canonical have already been written.
        aliases: [{ id: randomUUID(), state: "superseded", reason: "no_delivery" }],
      }),
    ).rejects.toThrow();

    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: person } });
    expect(intents).toHaveLength(0);

    // And the canonical conversation was not left labelled by a window that never landed.
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: canonical } });
    expect(convo.canonicalIntentId).toBeNull();
    expect(convo.reconciledAt).toBeNull();
  });

  it("writes the intent and repoints every conversation when it succeeds", async () => {
    const person = `${fx.igUserId}-${randomUUID()}`;
    const canonical = await seedConversation({ gate: "event", person });
    const alias = await seedConversation({ gate: "none", person });

    const { intentId } = await repo.applyReconciledWindow({
      igUserId: person,
      keywordId: fx.keywordId,
      canonicalId: canonical,
      windowStartedAt: CREATED_AT,
      lastTriggerAt: CREATED_AT,
      windowExpiresAt: new Date(CREATED_AT.getTime() + 48 * 3600_000),
      completedAt: null,
      choice: "confirmed_gate",
      aliases: [{ id: alias, state: "superseded", reason: "no_delivery" }],
    });

    const rows = await prisma.conversation.findMany({ where: { igUserId: person } });
    expect(rows.every((r) => r.canonicalIntentId === intentId)).toBe(true);
    expect(rows.find((r) => r.id === alias)!.reconciliationReason).toBe("superseded:no_delivery");
  });
});

// QA-15 part 3. The two paths key a window differently: the live path uses the trigger's
// receivedAt, reconciliation uses conversation.createdAt. The unique index is on the exact
// windowStartedAt, so near-identical windows produce TWO intents for one real journey.
//
// Latent today — measured in production, the closest same-person-keyword pair is 2.35 days
// apart, so no duplicate exists. It becomes live the moment reconciliation is re-run,
// which is exactly what the evidence fix above requires.
describeWithLocalDatabase("re-running reconciliation cannot duplicate or hijack a journey", () => {
  const WINDOW_MS = 48 * 3600_000;

  async function existingIntent(person: string, opts: { startedAt: Date; live: boolean }) {
    return prisma.journeyIntent.create({
      data: {
        igUserId: person,
        keywordId: fx.keywordId,
        windowStartedAt: opts.startedAt,
        lastTriggerAt: opts.startedAt,
        // A live journey is one still inside its window and not yet completed.
        windowExpiresAt: opts.live
          ? new Date(Date.now() + WINDOW_MS)
          : new Date(opts.startedAt.getTime() + WINDOW_MS),
        completedAt: opts.live ? null : opts.startedAt,
      },
    });
  }

  function windowFor(person: string, canonicalId: string) {
    return {
      igUserId: person,
      keywordId: fx.keywordId,
      canonicalId,
      windowStartedAt: CREATED_AT,
      lastTriggerAt: CREATED_AT,
      windowExpiresAt: new Date(CREATED_AT.getTime() + WINDOW_MS),
      completedAt: null,
      choice: "confirmed_gate",
      aliases: [] as Array<{ id: string; state: string; reason: string }>,
    };
  }

  // A journey the live path is currently driving must not have its canonical repointed
  // underneath it — that is the conversation the gate and DONE flow are running against.
  it("skips a live intent instead of hijacking it", async () => {
    const person = `${fx.igUserId}-${randomUUID()}`;
    const canonical = await seedConversation({ gate: "event", person });
    // Keyed 3ms off, exactly the way the two paths drift.
    const live = await existingIntent(person, {
      startedAt: new Date(CREATED_AT.getTime() + 3),
      live: true,
    });

    const result = await repo.applyReconciledWindow(windowFor(person, canonical));

    expect(result.outcome).toBe("skipped_live_intent");
    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: person } });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.id).toBe(live.id);
    expect(intents[0]!.canonicalConversationId).toBeNull();
  });

  // A settled intent from an earlier reconciliation run is the SAME journey, so a re-run
  // must update it rather than leaving two intents describing one request.
  it("updates an overlapping settled intent rather than duplicating it", async () => {
    const person = `${fx.igUserId}-${randomUUID()}`;
    const canonical = await seedConversation({ gate: "event", person });
    const prior = await existingIntent(person, {
      startedAt: new Date(CREATED_AT.getTime() + 3),
      live: false,
    });

    const result = await repo.applyReconciledWindow(windowFor(person, canonical));

    expect(result.outcome).toBe("written");
    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: person } });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.id).toBe(prior.id);
    expect(intents[0]!.canonicalConversationId).toBe(canonical);
  });
});
