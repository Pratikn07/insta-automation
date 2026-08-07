import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Gated on a real Postgres, like the other contract suites: a skipped test looks
// identical to a passing one in the summary line, so `npm test` alone cannot be
// trusted to have exercised any of this. See docs/meta-verification.md.
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// journey_intent has required foreign keys to keywords, and journey_trigger to
// the intent. A freshly migrated database holds no rows, so every assertion needs
// its own scaffolding — otherwise an insert quietly affects nothing and the
// constraint under test is never reached.

type IntentFixture = {
  resourceId: string;
  keywordId: string;
  igUserId: string;
  conversationId: string;
};

let fixture: IntentFixture;

async function createIntentFixture(client: PrismaClient): Promise<IntentFixture> {
  const created: IntentFixture = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `intent-contract-user-${randomUUID()}`,
    conversationId: randomUUID(),
  };

  await client.resource.create({
    data: { id: created.resourceId, name: "Journey intent contract resource" },
  });
  await client.keyword.create({
    data: {
      id: created.keywordId,
      keyword: `intent-contract-${created.keywordId}`,
      resourceId: created.resourceId,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await client.igUser.create({ data: { id: created.igUserId } });
  await client.conversation.create({
    data: {
      id: created.conversationId,
      igUserId: created.igUserId,
      keywordId: created.keywordId,
    },
  });

  return created;
}

async function deleteIntentFixture(client: PrismaClient, target: IntentFixture): Promise<void> {
  await client.journeyTrigger.deleteMany({ where: { intent: { igUserId: target.igUserId } } });
  await client.journeyIntent.deleteMany({ where: { igUserId: target.igUserId } });
  await client.conversation.deleteMany({ where: { id: target.conversationId } });
  await client.igUser.deleteMany({ where: { id: target.igUserId } });
  await client.keyword.deleteMany({ where: { id: target.keywordId } });
  await client.resource.deleteMany({ where: { id: target.resourceId } });
}

const WINDOW_MS = 48 * 60 * 60 * 1000;

function intentData(overrides: Record<string, unknown> = {}) {
  const startedAt = new Date();
  return {
    igUserId: fixture.igUserId,
    keywordId: fixture.keywordId,
    windowStartedAt: startedAt,
    lastTriggerAt: startedAt,
    windowExpiresAt: new Date(startedAt.getTime() + WINDOW_MS),
    ...overrides,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  fixture = await createIntentFixture(prisma);
});

afterAll(async () => {
  if (!prisma) return;
  if (fixture) await deleteIntentFixture(prisma, fixture);
  await prisma.$disconnect();
});

describeWithLocalDatabase("journey intent database contract", () => {
  afterEach(async () => {
    if (!prisma) return;
    await prisma.journeyTrigger.deleteMany({ where: { intent: { igUserId: fixture.igUserId } } });
    await prisma.journeyIntent.deleteMany({ where: { igUserId: fixture.igUserId } });
  });

  it("creates both tables with snake_case names", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('journey_intent', 'journey_trigger')
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual(["journey_intent", "journey_trigger"]);
  });

  // These tables record who asked for what. They are reachable only through the
  // service role, so RLS is on and NO policy exists — a permissive policy would
  // expose them to anon.
  it("enables RLS on both tables with no permissive policies", async () => {
    const rls = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('journey_intent', 'journey_trigger')
    `;
    expect(rls).toHaveLength(2);
    for (const row of rls) expect(row.relrowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM pg_policies
      WHERE tablename IN ('journey_intent', 'journey_trigger')
    `;
    expect(Number(policies[0]!.count)).toBe(0);
  });

  it("stores every intent timestamp with a time zone", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'journey_intent'
        AND column_name IN ('window_started_at', 'last_trigger_at', 'window_expires_at', 'completed_at')
    `;
    expect(cols).toHaveLength(4);
    for (const col of cols) expect(col.data_type).toBe("timestamp with time zone");
  });

  // The constraint the concurrent-first-trigger case leans on: two simultaneous
  // comments race to insert, one wins, and the loser must be forced to read the
  // winner's row rather than opening a parallel journey for the same request.
  it("permits only one intent per person, keyword, and window start", async () => {
    const startedAt = new Date();
    await prisma.journeyIntent.create({ data: intentData({ windowStartedAt: startedAt, lastTriggerAt: startedAt }) });

    await expect(
      prisma.journeyIntent.create({ data: intentData({ windowStartedAt: startedAt, lastTriggerAt: startedAt }) }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same person and keyword in a later window", async () => {
    const first = new Date("2026-08-01T00:00:00.000Z");
    const later = new Date("2026-08-05T00:00:00.000Z");
    await prisma.journeyIntent.create({ data: intentData({ windowStartedAt: first, lastTriggerAt: first }) });

    const second = await prisma.journeyIntent.create({
      data: intentData({ windowStartedAt: later, lastTriggerAt: later }),
    });

    expect(second.windowStartedAt.toISOString()).toBe(later.toISOString());
  });

  // window_expires_at is derived from last_trigger_at. If it could precede it, a
  // live intent would read as expired and a second journey would open — the exact
  // duplicate this table exists to prevent.
  it("rejects a window that expires before its last trigger", async () => {
    const now = new Date();
    await expect(
      prisma.journeyIntent.create({
        data: intentData({
          windowStartedAt: now,
          lastTriggerAt: now,
          windowExpiresAt: new Date(now.getTime() - 1000),
        }),
      }),
    ).rejects.toThrow();
  });

  it("rejects a trigger recorded before its window opened", async () => {
    const now = new Date();
    await expect(
      prisma.journeyIntent.create({
        data: intentData({
          windowStartedAt: now,
          lastTriggerAt: new Date(now.getTime() - 1000),
        }),
      }),
    ).rejects.toThrow();
  });

  // Exact webhook replay. Meta redelivers the same comment id, and it must attach
  // to the existing trigger rather than creating a second one.
  it("rejects a duplicate comment id with P2002", async () => {
    const intent = await prisma.journeyIntent.create({ data: intentData() });
    const commentId = `intent-contract-comment-${randomUUID()}`;

    await prisma.journeyTrigger.create({
      data: {
        intentId: intent.id,
        conversationId: fixture.conversationId,
        commentId,
        receivedAt: new Date(),
        triggerKind: "comment",
        disposition: "new_journey",
      },
    });

    await expect(
      prisma.journeyTrigger.create({
        data: {
          intentId: intent.id,
          commentId,
          receivedAt: new Date(),
          triggerKind: "comment",
          disposition: "replayed_comment",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps many distinct triggers on one intent", async () => {
    const intent = await prisma.journeyIntent.create({ data: intentData() });
    for (const disposition of ["new_journey", "reused_active"] as const) {
      await prisma.journeyTrigger.create({
        data: {
          intentId: intent.id,
          conversationId: fixture.conversationId,
          commentId: `intent-contract-comment-${randomUUID()}`,
          receivedAt: new Date(),
          triggerKind: "comment",
          disposition,
        },
      });
    }

    const triggers = await prisma.journeyTrigger.findMany({ where: { intentId: intent.id } });
    expect(triggers).toHaveLength(2);
  });

  // "Never delete history" (design §4.5). Losing the canonical conversation must
  // not erase the intent or the record of every comment that asked for the guide.
  it("keeps the intent and its triggers when the canonical conversation is deleted", async () => {
    const doomedId = randomUUID();
    await prisma.conversation.create({
      data: { id: doomedId, igUserId: fixture.igUserId, keywordId: fixture.keywordId },
    });
    const intent = await prisma.journeyIntent.create({
      data: intentData({ canonicalConversationId: doomedId }),
    });
    await prisma.journeyTrigger.create({
      data: {
        intentId: intent.id,
        conversationId: doomedId,
        commentId: `intent-contract-comment-${randomUUID()}`,
        receivedAt: new Date(),
        triggerKind: "comment",
        disposition: "new_journey",
      },
    });

    await prisma.conversation.delete({ where: { id: doomedId } });

    const survived = await prisma.journeyIntent.findUnique({ where: { id: intent.id } });
    expect(survived).not.toBeNull();
    expect(survived!.canonicalConversationId).toBeNull();

    const triggers = await prisma.journeyTrigger.findMany({ where: { intentId: intent.id } });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.conversationId).toBeNull();
  });

  it("defaults a new intent to canonical", async () => {
    const intent = await prisma.journeyIntent.create({ data: intentData() });
    expect(intent.reconciledState).toBe("canonical");
  });

  // Every conversation in production predates reconciliation, so the back-
  // references must be nullable — a null means "not yet reconciled", never
  // "no owner".
  it("leaves the conversation back-references null until reconciliation runs", async () => {
    const convo = await prisma.conversation.findUnique({ where: { id: fixture.conversationId } });
    expect(convo!.canonicalIntentId).toBeNull();
    expect(convo!.reconciledAt).toBeNull();
    expect(convo!.reconciliationReason).toBeNull();
  });
});
