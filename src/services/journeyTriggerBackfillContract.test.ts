import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// QA-16. `backfill-journey-triggers.ts` joined only `canonical_conversation_id` and
// skipped any intent that already had a trigger, so an alias conversation's comment was
// never recorded: a person who asked three times appeared to have asked once.
//
// Measured in production before the fix: 749 alias conversations had no trigger row. 480
// were DM-sourced (no comment exists, and Feature 4 excludes the source anyway), 217 had
// a recoverable comment id, 52 had neither. Of the eligible pool, 142 intents were
// affected and 54 held a comment NEWER than the one recorded — which is why QA-11's
// "reply to the newest available source" could not work until this ran.
//
// Real Postgres, because the defect was in a JOIN and a NOT EXISTS. A mocked client would
// reproduce whichever query the test itself wrote.

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;
let backfill: (write: boolean) => Promise<{
  conversationsWithoutTrigger: number;
  aliasRows: number;
  wrote: number;
  skippedNoComment: number;
  skippedClaimed: number;
}>;

type Fixture = { resourceId: string; keywordId: string; keywordId2: string; igUserId: string };
let fx: Fixture;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  // Drives the REAL sweep. A test that rebuilt the query would pass against the bug.
  ({ backfillJourneyTriggers: backfill } = await import(
    "../../scripts/backfill-journey-triggers.js"
  ));

  fx = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    keywordId2: randomUUID(),
    igUserId: `trig-backfill-${randomUUID()}`,
  };
  await prisma.resource.create({ data: { id: fx.resourceId, name: "trigger backfill" } });
  for (const [id, word] of [
    [fx.keywordId, "SLEEP"],
    [fx.keywordId2, "POTTY"],
  ] as const) {
    await prisma.keyword.create({
      data: {
        id,
        keyword: `${word}-${id}`,
        resourceId: fx.resourceId,
        publicReply: "x",
        gateMessage: "y",
      },
    });
  }
});

/**
 * Every test starts from an empty journey table.
 *
 * The sweep is global by design, so leftover rows from an earlier case would be swept
 * again and inflate the counts under test.
 */
beforeEach(async () => {
  if (!prisma) return;
  await prisma.journeyTrigger.deleteMany({ where: { intent: { igUserId: { startsWith: fx.igUserId } } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
});

afterAll(async () => {
  if (!prisma) return;
  await prisma.journeyTrigger.deleteMany({ where: { intent: { igUserId: { startsWith: fx.igUserId } } } });
  await prisma.conversation.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.journeyIntent.deleteMany({ where: { igUserId: { startsWith: fx.igUserId } } });
  await prisma.igUser.deleteMany({ where: { id: { startsWith: fx.igUserId } } });
  await prisma.keyword.deleteMany({ where: { id: { in: [fx.keywordId, fx.keywordId2] } } });
  await prisma.resource.deleteMany({ where: { id: fx.resourceId } });
  await prisma.$disconnect();
});

/**
 * One journey: an intent, its canonical conversation, and `aliasCount` later asks.
 *
 * Each conversation gets a `keyword_matched` event carrying its own comment id, which is
 * where the sweep reads from — mirroring how production data actually looks.
 */
async function seedJourney(opts: {
  aliasCount: number;
  keywordId?: string;
  source?: string;
  person?: string;
}): Promise<{ intentId: string; commentIds: string[] }> {
  const keywordId = opts.keywordId ?? fx.keywordId;
  const igUserId = opts.person ?? `${fx.igUserId}-${randomUUID()}`;
  const base = new Date("2026-06-01T10:00:00Z");
  const commentIds: string[] = [];

  await prisma.igUser.upsert({ where: { id: igUserId }, create: { id: igUserId }, update: {} });
  const intent = await prisma.journeyIntent.create({
    data: {
      igUserId,
      keywordId,
      windowStartedAt: base,
      lastTriggerAt: base,
      windowExpiresAt: new Date(base.getTime() + 48 * 3600_000),
    },
  });

  for (let i = 0; i <= opts.aliasCount; i++) {
    const createdAt = new Date(base.getTime() + i * 3600_000);
    const convo = await prisma.conversation.create({
      data: {
        igUserId,
        keywordId,
        state: "awaiting_done",
        createdAt,
        // Aliases point at the intent; the canonical one is named by the intent itself.
        ...(i === 0 ? {} : { canonicalIntentId: intent.id, reconciliationReason: "superseded" }),
      },
    });
    if (i === 0) {
      await prisma.journeyIntent.update({
        where: { id: intent.id },
        data: { canonicalConversationId: convo.id },
      });
    }

    const commentId = `bf-c-${randomUUID()}`;
    commentIds.push(commentId);
    await prisma.eventLog.create({
      data: {
        kind: "keyword_matched",
        payload: {
          conversationId: convo.id,
          commentId,
          mediaId: `media-${i}`,
          ...(opts.source ? { source: opts.source } : {}),
        },
        createdAt,
      },
    });
  }

  return { intentId: intent.id, commentIds };
}

describeWithLocalDatabase("journey trigger backfill covers alias history", () => {
  // THE case QA-16 asked for. Before the fix this wrote 1 and the two later asks were
  // lost from the canonical timeline entirely.
  it("records every alias comment, not just the canonical one", async () => {
    const { intentId, commentIds } = await seedJourney({ aliasCount: 2 });

    const summary = await backfill(true);

    expect(summary.wrote).toBe(3);
    const triggers = await prisma.journeyTrigger.findMany({
      where: { intentId },
      orderBy: { receivedAt: "asc" },
      include: { sourceEvent: true },
    });
    expect(triggers.map((t) => t.sourceEvent.commentId)).toEqual(commentIds);
  });

  // Each alias keeps its OWN time. Stamping them all with the window start would make
  // every trigger look simultaneous and destroy the ordering "newest source" needs.
  it("keeps each alias at its own timestamp so ordering survives", async () => {
    const { intentId } = await seedJourney({ aliasCount: 2 });

    await backfill(true);

    const times = (
      await prisma.journeyTrigger.findMany({
        where: { intentId },
        orderBy: { receivedAt: "asc" },
        select: { receivedAt: true },
      })
    ).map((t) => t.receivedAt.getTime());
    expect(new Set(times).size).toBe(3);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  // Only the canonical conversation opened the journey. Stamping every reconstructed
  // trigger `new_journey` claimed each alias had started its own.
  it("labels the canonical trigger new_journey and aliases reused_active", async () => {
    const { intentId } = await seedJourney({ aliasCount: 2 });

    await backfill(true);

    const rows = await prisma.journeyTrigger.findMany({
      where: { intentId },
      orderBy: { receivedAt: "asc" },
      select: { disposition: true },
    });
    expect(rows.map((r) => r.disposition)).toEqual([
      "new_journey",
      "reused_active",
      "reused_active",
    ]);
  });

  // An intent that ALREADY has its canonical trigger — from the live path or an earlier
  // run — must still gain its aliases. The old NOT EXISTS was per intent, so one
  // existing trigger hid every alias behind it.
  it("adds aliases to an intent that already has a trigger", async () => {
    const { intentId, commentIds } = await seedJourney({ aliasCount: 1 });
    const canonicalConvo = await prisma.journeyIntent.findUnique({
      where: { id: intentId },
      select: { canonicalConversationId: true },
    });
    const sourceEvent = await prisma.journeySourceEvent.create({
      data: {
        commentId: commentIds[0],
        firstReceivedAt: new Date("2026-06-01T10:00:00Z"),
      },
    });
    await prisma.journeyTrigger.create({
      data: {
        intentId,
        keywordId: fx.keywordId,
        conversationId: canonicalConvo!.canonicalConversationId,
        sourceEventId: sourceEvent.id,
        receivedAt: new Date("2026-06-01T10:00:00Z"),
        triggerKind: "comment",
        disposition: "new_journey",
      },
    });

    const summary = await backfill(true);

    expect(summary.wrote).toBe(1);
    expect(await prisma.journeyTrigger.count({ where: { intentId } })).toBe(2);
  });

  // Re-running must be a no-op, or an operator cannot safely repeat it after a partial
  // failure.
  //
  // Asserted on THIS journey's rows rather than the sweep's global totals: the sweep is
  // global by design, so when the whole suite runs, other suites' fixtures are swept too
  // and the global counts are not zero on the second pass. The property under test is
  // that a second run adds nothing.
  it("is idempotent across reruns", async () => {
    const { intentId } = await seedJourney({ aliasCount: 2 });

    await backfill(true);
    const afterFirst = await prisma.journeyTrigger.findMany({
      where: { intentId },
      orderBy: { receivedAt: "asc" },
      select: {
        disposition: true,
        receivedAt: true,
        sourceEvent: { select: { commentId: true } },
      },
    });

    await backfill(true);
    const afterSecond = await prisma.journeyTrigger.findMany({
      where: { intentId },
      orderBy: { receivedAt: "asc" },
      select: {
        disposition: true,
        receivedAt: true,
        sourceEvent: { select: { commentId: true } },
      },
    });

    expect(afterFirst).toHaveLength(3);
    expect(afterSecond).toEqual(afterFirst);
  });

  // A dry run must write nothing while still reporting what it would do.
  it("writes nothing on a dry run", async () => {
    const { intentId } = await seedJourney({ aliasCount: 2 });

    const summary = await backfill(false);

    expect(summary.wrote).toBe(3);
    expect(await prisma.journeyTrigger.count({ where: { intentId } })).toBe(0);
  });

  // One source comment can legitimately match two keyword rows — two guides genuinely
  // requested. The association is unique per comment + keyword, not globally by comment.
  it("retains one comment as history for two distinct keyword intents", async () => {
    const person = `${fx.igUserId}-shared-${randomUUID()}`;
    const first = await seedJourney({ aliasCount: 0, person });
    // A second intent on a different keyword, pointing at the SAME comment id.
    const base = new Date("2026-06-01T10:00:00Z");
    const intent2 = await prisma.journeyIntent.create({
      data: {
        igUserId: person,
        keywordId: fx.keywordId2,
        windowStartedAt: base,
        lastTriggerAt: base,
        windowExpiresAt: new Date(base.getTime() + 48 * 3600_000),
      },
    });
    const convo2 = await prisma.conversation.create({
      data: { igUserId: person, keywordId: fx.keywordId2, state: "awaiting_done", createdAt: base },
    });
    await prisma.journeyIntent.update({
      where: { id: intent2.id },
      data: { canonicalConversationId: convo2.id },
    });
    await prisma.eventLog.create({
      data: {
        kind: "keyword_matched",
        payload: { conversationId: convo2.id, commentId: first.commentIds[0] },
        createdAt: base,
      },
    });

    const summary = await backfill(true);

    expect(summary.wrote).toBe(2);
    expect(summary.skippedClaimed).toBe(0);
    const associations = await prisma.journeyTrigger.findMany({
      where: { sourceEvent: { commentId: first.commentIds[0] } },
      orderBy: { keywordId: "asc" },
      select: {
        intentId: true,
        keywordId: true,
        sourceEvent: { select: { commentId: true } },
      },
    });
    expect(associations).toEqual([
      {
        intentId: first.intentId,
        keywordId: fx.keywordId,
        sourceEvent: { commentId: first.commentIds[0] },
      },
      {
        intentId: intent2.id,
        keywordId: fx.keywordId2,
        sourceEvent: { commentId: first.commentIds[0] },
      },
    ].sort((left, right) => left.keywordId.localeCompare(right.keywordId)));
  });

  it("retains every distinct source event on one conversation with original evidence", async () => {
    const { intentId } = await seedJourney({ aliasCount: 0 });
    const intent = await prisma.journeyIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { canonicalConversationId: true },
    });
    const secondAt = new Date("2026-06-01T11:15:00Z");
    const secondCommentId = `bf-c-${randomUUID()}`;
    const secondEvent = await prisma.eventLog.create({
      data: {
        kind: "keyword_matched",
        payload: {
          conversationId: intent.canonicalConversationId,
          commentId: secondCommentId,
          mediaId: "media-second",
          source: "comment",
          journeyDisposition: "reused_active",
        },
        createdAt: secondAt,
      },
    });
    await prisma.eventLog.create({
      data: {
        kind: "public_reply_failed",
        payload: {
          conversationId: intent.canonicalConversationId,
          commentId: secondCommentId,
          category: "graph_response",
        },
        createdAt: new Date(secondAt.getTime() + 1000),
      },
    });

    const summary = await backfill(true);

    expect(summary.wrote).toBe(2);
    const rows = await prisma.journeyTrigger.findMany({
      where: { intentId },
      orderBy: { receivedAt: "asc" },
      select: {
        sourceEventLogId: true,
        receivedAt: true,
        disposition: true,
        publicAcknowledgementState: true,
        acknowledgementErrorCategory: true,
        sourceEvent: { select: { commentId: true, mediaId: true } },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      sourceEventLogId: secondEvent.id,
      receivedAt: secondAt,
      disposition: "reused_active",
      publicAcknowledgementState: "failed",
      acknowledgementErrorCategory: "graph_response",
      sourceEvent: { commentId: secondCommentId, mediaId: "media-second" },
    });
  });

  // A DM-matched keyword has no comment to reply to. It must be recorded as `dm` so the
  // selector can exclude it (§35), not silently treated as a comment.
  it("records a DM-sourced ask as kind dm", async () => {
    const { intentId } = await seedJourney({ aliasCount: 1, source: "dm" });

    await backfill(true);

    const kinds = await prisma.journeyTrigger.findMany({
      where: { intentId },
      select: { triggerKind: true },
    });
    expect(new Set(kinds.map((k) => k.triggerKind))).toEqual(new Set(["dm"]));
  });
});
