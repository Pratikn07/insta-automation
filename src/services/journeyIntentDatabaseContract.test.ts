import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  resolveJourneyIntent,
  markIntentCompleted,
  JOURNEY_WINDOW_MS,
  type JourneyTriggerInput,
} from "./journeyIntentService.js";

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
  // By person, not by the one known id: the alias-completion tests create additional
  // conversations for this fixture and the keyword delete below fails if any remain.
  await client.conversation.deleteMany({ where: { igUserId: target.igUserId } });
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

  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.

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
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('journey_intent', 'journey_trigger')
    `;
    expect(rls).toHaveLength(2);
    for (const row of rls) expect(row.relrowsecurity).toBe(true);

    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('journey_intent', 'journey_trigger')
    `;
    expect(Number(policies[0]!.count)).toBe(0);
  });

  it("stores every intent timestamp with a time zone", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'journey_intent'
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

// ── A2: resolveJourneyIntent ──────────────────────────────────────────────
//
// The behaviour these assert cannot be proven by reading the code: the 48-hour
// boundary depends on database time, and the concurrency guarantee depends on a
// real unique index under a real serializable transaction.

describeWithLocalDatabase("resolveJourneyIntent", () => {
  afterEach(async () => {
    if (!prisma) return;
    await prisma.journeyTrigger.deleteMany({ where: { intent: { igUserId: fixture.igUserId } } });
    await prisma.conversation.updateMany({
      where: { igUserId: fixture.igUserId },
      data: { canonicalIntentId: null },
    });
    await prisma.journeyIntent.deleteMany({ where: { igUserId: fixture.igUserId } });
    await prisma.conversation.deleteMany({
      where: { igUserId: fixture.igUserId, id: { not: fixture.conversationId } },
    });
  });

  function trigger(overrides: Partial<JourneyTriggerInput> = {}): JourneyTriggerInput {
    return {
      igUserId: fixture.igUserId,
      keywordId: fixture.keywordId,
      commentId: `resolve-contract-${randomUUID()}`,
      receivedAt: new Date(),
      triggerKind: "comment",
      ...overrides,
    };
  }

  // Each new journey needs its own conversation, mirroring what openConversation
  // does on the live path.
  const makeConversation = (tx: Parameters<Parameters<typeof resolveJourneyIntent>[1]>[0]) =>
    tx.conversation.create({
      data: { igUserId: fixture.igUserId, keywordId: fixture.keywordId },
      select: { id: true },
    });

  it("opens a journey for a first-time request and authorises the gate", async () => {
    const result = await resolveJourneyIntent(trigger(), makeConversation);

    expect(result.disposition).toBe("new_journey");
    expect(result.maySendGate).toBe(true);
    expect(result.conversationId).not.toBeNull();

    // The conversation points back at its intent, so reconciliation can find it.
    const convo = await prisma.conversation.findUnique({ where: { id: result.conversationId! } });
    expect(convo!.canonicalIntentId).toBe(result.intentId);
  });

  // The whole point of Feature 3: this is the case that sent a duplicate gate DM
  // 342 times in production.
  it("reuses the journey for a second comment inside the window and forbids a second gate", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);
    const second = await resolveJourneyIntent(trigger(), makeConversation);

    expect(second.disposition).toBe("reused_active");
    expect(second.maySendGate).toBe(false);
    expect(second.intentId).toBe(first.intentId);
    expect(second.conversationId).toBe(first.conversationId);

    // One journey, but both asks retained.
    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: fixture.igUserId } });
    expect(intents).toHaveLength(1);
    const triggers = await prisma.journeyTrigger.findMany({ where: { intentId: first.intentId } });
    expect(triggers).toHaveLength(2);
  });

  // Media id is not part of the identity, so the SAME keyword row reached from two
  // different posts is one request. This is the global-keyword case: one row, no
  // media, reachable from every reel.
  it("reuses the journey for one keyword row reached from two posts", async () => {
    const first = await resolveJourneyIntent(trigger({ mediaId: "media-a" }), makeConversation);
    const second = await resolveJourneyIntent(trigger({ mediaId: "media-b" }), makeConversation);

    expect(second.disposition).toBe("reused_active");
    expect(second.intentId).toBe(first.intentId);
  });

  // The other half, and the one that is easy to get wrong. Identity is the keyword
  // ID, never the word (design §19). In this data DINNER exists as three separate
  // keyword rows — one global, one per reel — each pointing at a DIFFERENT guide.
  // Two comments on two reels must therefore stay two intents, because two
  // different things were asked for.
  it("keeps same-word keyword rows on different posts as separate journeys", async () => {
    const sameWordOtherPost = randomUUID();
    const otherResource = randomUUID();
    await prisma.resource.create({ data: { id: otherResource, name: "Other guide, same word" } });
    await prisma.keyword.create({
      data: {
        id: sameWordOtherPost,
        // Same displayed word as the fixture keyword, different row and guide.
        keyword: `intent-contract-${fixture.keywordId}`,
        mediaId: "media-b",
        resourceId: otherResource,
        publicReply: "test",
        gateMessage: "test",
      },
    });

    const first = await resolveJourneyIntent(trigger({ mediaId: "media-a" }), makeConversation);
    const second = await resolveJourneyIntent(
      trigger({ keywordId: sameWordOtherPost, mediaId: "media-b" }),
      (tx) =>
        tx.conversation.create({
          data: { igUserId: fixture.igUserId, keywordId: sameWordOtherPost },
          select: { id: true },
        }),
    );

    expect(second.disposition).toBe("new_journey");
    expect(second.intentId).not.toBe(first.intentId);

    await prisma.journeyTrigger.deleteMany({ where: { intentId: second.intentId } });
    await prisma.conversation.updateMany({
      where: { keywordId: sameWordOtherPost },
      data: { canonicalIntentId: null },
    });
    await prisma.journeyIntent.deleteMany({ where: { keywordId: sameWordOtherPost } });
    await prisma.conversation.deleteMany({ where: { keywordId: sameWordOtherPost } });
    await prisma.keyword.delete({ where: { id: sameWordOtherPost } });
    await prisma.resource.delete({ where: { id: otherResource } });
  });

  it("opens a new journey once the window has lapsed", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);

    // Age the whole window rather than sleeping 48 hours. windowStartedAt must
    // move too: chk_intent_trigger_after_start correctly forbids a trigger that
    // predates its own window.
    const aged = new Date(Date.now() - JOURNEY_WINDOW_MS - 60_000);
    await prisma.journeyIntent.update({
      where: { id: first.intentId },
      data: {
        windowStartedAt: aged,
        lastTriggerAt: aged,
        windowExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const second = await resolveJourneyIntent(trigger(), makeConversation);

    expect(second.disposition).toBe("new_journey");
    expect(second.maySendGate).toBe(true);
    expect(second.intentId).not.toBe(first.intentId);
  });

  // A redelivered webhook must be inert: no second trigger, no refreshed window,
  // and above all no second gate DM.
  it("treats a redelivered comment as a replay and changes nothing", async () => {
    const input = trigger();
    const first = await resolveJourneyIntent(input, makeConversation);
    const before = await prisma.journeyIntent.findUnique({ where: { id: first.intentId } });

    const replay = await resolveJourneyIntent(input, makeConversation);

    expect(replay.disposition).toBe("replayed_comment");
    expect(replay.maySendGate).toBe(false);
    expect(replay.intentId).toBe(first.intentId);

    const triggers = await prisma.journeyTrigger.findMany({ where: { intentId: first.intentId } });
    expect(triggers).toHaveLength(1);

    const after = await prisma.journeyIntent.findUnique({ where: { id: first.intentId } });
    expect(after!.lastTriggerAt.toISOString()).toBe(before!.lastTriggerAt.toISOString());
  });

  it("reports a completed request inside the window without re-sending", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);
    await prisma.journeyIntent.update({
      where: { id: first.intentId },
      data: { completedAt: new Date() },
    });

    const second = await resolveJourneyIntent(trigger(), makeConversation);

    expect(second.disposition).toBe("already_completed_recently");
    expect(second.maySendGate).toBe(false);
    expect(second.intentId).toBe(first.intentId);
  });

  // A completed intent must not have its window extended, or a genuinely new
  // request after the window would keep reading as "already completed".
  it("does not extend the window after completion", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);
    await prisma.journeyIntent.update({
      where: { id: first.intentId },
      data: { completedAt: new Date() },
    });
    const before = await prisma.journeyIntent.findUnique({ where: { id: first.intentId } });

    await resolveJourneyIntent(trigger(), makeConversation);

    const after = await prisma.journeyIntent.findUnique({ where: { id: first.intentId } });
    expect(after!.windowExpiresAt.toISOString()).toBe(before!.windowExpiresAt.toISOString());
  });

  // The race the unique index exists for. Two comments arriving together must not
  // both conclude they are first, or the person gets two gate DMs.
  it("gives exactly one of two simultaneous first triggers the new journey", async () => {
    const results = await Promise.all([
      resolveJourneyIntent(trigger(), makeConversation),
      resolveJourneyIntent(trigger(), makeConversation),
    ]);

    const opened = results.filter((r) => r.disposition === "new_journey");
    expect(opened).toHaveLength(1);
    expect(results.filter((r) => r.maySendGate)).toHaveLength(1);

    // And one journey exists, not two.
    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: fixture.igUserId } });
    expect(intents).toHaveLength(1);
  });

  it("survives a burst of concurrent triggers with a single journey", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveJourneyIntent(trigger(), makeConversation)),
    );

    expect(results.filter((r) => r.maySendGate)).toHaveLength(1);
    const intents = await prisma.journeyIntent.findMany({ where: { igUserId: fixture.igUserId } });
    expect(intents).toHaveLength(1);
    const triggers = await prisma.journeyTrigger.findMany({ where: { intentId: intents[0]!.id } });
    expect(triggers).toHaveLength(5);
  });

  // The deterministic form of what made the burst above fail intermittently.
  //
  // `receivedAt` is stamped when the handler picks the comment up
  // (commentHandler.ts:125 — the comment webhook carries no timestamp), so two handlers
  // can take their timestamps in one order and commit in the other. The winner's
  // `receivedAt` becomes `window_started_at`; the loser then attaches and writes its own,
  // EARLIER, `receivedAt` as `last_trigger_at` — violating chk_intent_trigger_after_start.
  //
  // 23514 is not a serialization conflict, so the retry loop does not catch it and the
  // error leaves `resolveJourneyIntent`. That function throws by design because the
  // caller must not send a gate DM it cannot account for — so the person who commented
  // silently never receives their guide.
  it("attaches a trigger that arrived before the window started", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);
    const intent = await prisma.journeyIntent.findUniqueOrThrow({ where: { id: first.intentId } });

    // One millisecond of clock inversion is all it takes; the captured production-shaped
    // failure was exactly this.
    const earlier = new Date(intent.windowStartedAt.getTime() - 1);
    const second = await resolveJourneyIntent(trigger({ receivedAt: earlier }), makeConversation);

    expect(second.disposition).toBe("reused_active");
    expect(second.maySendGate).toBe(false);

    // The window must not move backwards either: an out-of-order trigger records the ask
    // without shortening the journey it attached to.
    const after = await prisma.journeyIntent.findUniqueOrThrow({ where: { id: first.intentId } });
    expect(after.lastTriggerAt.getTime()).toBeGreaterThanOrEqual(after.windowStartedAt.getTime());
    expect(after.windowExpiresAt.getTime()).toBeGreaterThanOrEqual(intent.windowExpiresAt.getTime());
  });

  // Guards the fix against being "simplified" to a clamp on window_started_at, which
  // satisfies the constraint but is still wrong: with a later trigger already recorded, an
  // out-of-order one would rewind last_trigger_at and pull the expiry in with it, cutting
  // the journey short for everyone still inside it.
  it("does not rewind a journey that a later trigger already extended", async () => {
    const first = await resolveJourneyIntent(trigger(), makeConversation);
    const started = await prisma.journeyIntent.findUniqueOrThrow({ where: { id: first.intentId } });

    // A genuinely later ask extends the window.
    const later = new Date(started.windowStartedAt.getTime() + 60_000);
    await resolveJourneyIntent(trigger({ receivedAt: later }), makeConversation);
    const extended = await prisma.journeyIntent.findUniqueOrThrow({ where: { id: first.intentId } });

    // Now one that was picked up out of order, before the window even opened.
    const earlier = new Date(started.windowStartedAt.getTime() - 1);
    await resolveJourneyIntent(trigger({ receivedAt: earlier }), makeConversation);

    const final = await prisma.journeyIntent.findUniqueOrThrow({ where: { id: first.intentId } });
    expect(final.lastTriggerAt.getTime()).toBe(extended.lastTriggerAt.getTime());
    expect(final.windowExpiresAt.getTime()).toBe(extended.windowExpiresAt.getTime());
  });

  it("keeps different keywords as separate journeys", async () => {
    const otherKeywordId = randomUUID();
    await prisma.keyword.create({
      data: {
        id: otherKeywordId,
        keyword: `intent-contract-other-${otherKeywordId}`,
        resourceId: fixture.resourceId,
        publicReply: "test",
        gateMessage: "test",
      },
    });

    const first = await resolveJourneyIntent(trigger(), makeConversation);
    const second = await resolveJourneyIntent(
      trigger({ keywordId: otherKeywordId }),
      (tx) =>
        tx.conversation.create({
          data: { igUserId: fixture.igUserId, keywordId: otherKeywordId },
          select: { id: true },
        }),
    );

    expect(second.disposition).toBe("new_journey");
    expect(second.intentId).not.toBe(first.intentId);

    await prisma.journeyTrigger.deleteMany({ where: { intentId: second.intentId } });
    await prisma.conversation.updateMany({
      where: { keywordId: otherKeywordId },
      data: { canonicalIntentId: null },
    });
    await prisma.journeyIntent.deleteMany({ where: { keywordId: otherKeywordId } });
    await prisma.conversation.deleteMany({ where: { keywordId: otherKeywordId } });
    await prisma.keyword.delete({ where: { id: otherKeywordId } });
  });
});

// QA-05. Completion through an ALIAS must close the canonical intent. This previously
// matched only canonicalConversationId, and the gap was live in production:
// @gore2_7793 held their DINNER guide while intent d8fbe920 still read incomplete,
// which made them eligible for a public reminder about a guide they already had.
describeWithLocalDatabase("markIntentCompleted through an alias", () => {
  async function makeIntentWithAlias() {
    const startedAt = new Date();
    const canonical = await prisma.conversation.create({
      data: { igUserId: fixture.igUserId, keywordId: fixture.keywordId },
    });
    const intent = await prisma.journeyIntent.create({
      data: {
        igUserId: fixture.igUserId,
        keywordId: fixture.keywordId,
        canonicalConversationId: canonical.id,
        windowStartedAt: startedAt,
        lastTriggerAt: startedAt,
        windowExpiresAt: new Date(startedAt.getTime() + JOURNEY_WINDOW_MS),
      },
    });
    const alias = await prisma.conversation.create({
      data: {
        igUserId: fixture.igUserId,
        keywordId: fixture.keywordId,
        canonicalIntentId: intent.id,
        reconciliationReason: "superseded:not the canonical journey for this request",
      },
    });
    return { intentId: intent.id, canonicalId: canonical.id, aliasId: alias.id };
  }

  it("closes the intent when an alias completes", async () => {
    const { intentId, aliasId } = await makeIntentWithAlias();
    const completedAt = new Date();

    await prisma.$transaction((tx) => markIntentCompleted(tx, aliasId, completedAt));

    const intent = await prisma.journeyIntent.findUnique({ where: { id: intentId } });
    expect(intent?.completedAt).not.toBeNull();
  });

  it("still closes the intent when the canonical conversation completes", async () => {
    const { intentId, canonicalId } = await makeIntentWithAlias();

    await prisma.$transaction((tx) => markIntentCompleted(tx, canonicalId, new Date()));

    const intent = await prisma.journeyIntent.findUnique({ where: { id: intentId } });
    expect(intent?.completedAt).not.toBeNull();
  });

  // Idempotent: a later completion must not move the recorded time, or the first
  // delivery's timestamp would be lost.
  it("keeps the earliest completion time", async () => {
    const { intentId, canonicalId, aliasId } = await makeIntentWithAlias();
    const first = new Date("2026-08-01T00:00:00.000Z");

    await prisma.$transaction((tx) => markIntentCompleted(tx, aliasId, first));
    await prisma.$transaction((tx) => markIntentCompleted(tx, canonicalId, new Date()));

    const intent = await prisma.journeyIntent.findUnique({ where: { id: intentId } });
    expect(intent?.completedAt?.toISOString()).toBe(first.toISOString());
  });

  // A conversation belonging to no intent must not close somebody else's.
  it("closes nothing for an unlinked conversation", async () => {
    const { intentId } = await makeIntentWithAlias();
    const unrelated = await prisma.conversation.create({
      data: { igUserId: fixture.igUserId, keywordId: fixture.keywordId },
    });

    await prisma.$transaction((tx) => markIntentCompleted(tx, unrelated.id, new Date()));

    const intent = await prisma.journeyIntent.findUnique({ where: { id: intentId } });
    expect(intent?.completedAt).toBeNull();
  });
});
