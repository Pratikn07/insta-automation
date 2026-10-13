// src/services/insightsLeaderboardContract.test.ts
//
// Pins what the Insights leaderboard reports for each reel, against real
// Postgres: which snapshot counts as "latest", and how keyword_matched events
// turn into per-reel conversion counts. The leaderboard used to rebuild these in
// Node from every snapshot row and every keyword_matched payload; these
// assertions are what any cheaper query has to keep returning.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8);
const reelA = `lb-${suffix}-a`;
const reelB = `lb-${suffix}-b`;
const ids = {
  resource: randomUUID(),
  keyword: randomUUID(),
  completed: randomUUID(),
  gatedOnly: randomUUID(),
  ungated: randomUUID(),
  neverStored: randomUUID(),
};
const eventIds: string[] = [];
const DAY_MS = 86_400_000;
let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await db.resource.create({ data: { id: ids.resource, name: `Leaderboard ${suffix}` } });
  await db.keyword.create({
    data: { id: ids.keyword, keyword: `LB${suffix}`, resourceId: ids.resource, publicReply: "x", gateMessage: "x" },
  });
  await db.reelMeta.create({ data: { mediaId: reelA, caption: "A" } });
  await db.reelMeta.create({ data: { mediaId: reelB, caption: "B" } });

  const now = Date.now();
  // Inserted out of order on purpose: "latest" must mean newest captured_at.
  await db.reelPerformanceSnapshot.createMany({
    data: [
      { mediaId: reelA, capturedAt: new Date(now - 3 * DAY_MS), views: 100, reach: 50, skipRate: 0.9 },
      { mediaId: reelA, capturedAt: new Date(now - 1 * DAY_MS), views: 300, reach: 2000, skipRate: 0.4 },
      { mediaId: reelA, capturedAt: new Date(now - 2 * DAY_MS), views: 200, reach: 1000, skipRate: 0.6 },
    ],
  });

  const conversation = (id: string, state: "completed" | "awaiting_done", gatedAt: Date | null) =>
    db.conversation.create({
      data: { id, igUserId: `ig-${suffix}-${id.slice(0, 4)}`, keywordId: ids.keyword, state, gatedAt },
    });
  await conversation(ids.completed, "completed", new Date(now - DAY_MS));
  await conversation(ids.gatedOnly, "awaiting_done", new Date(now - DAY_MS));
  await conversation(ids.ungated, "awaiting_done", null);

  const matched = (payload: Record<string, unknown>) => {
    const id = randomUUID();
    eventIds.push(id);
    return { id, kind: "keyword_matched", payload };
  };
  await db.eventLog.createMany({
    data: [
      matched({ mediaId: reelA, conversationId: ids.completed }),
      // A repeat match on one conversation is one keyword comment, not two.
      matched({ mediaId: reelA, conversationId: ids.completed }),
      matched({ mediaId: reelA, conversationId: ids.gatedOnly }),
      // Counted as a keyword comment even though its conversation row is gone.
      matched({ mediaId: reelA, conversationId: ids.neverStored }),
      // Unattributable: no conversation, no reel, or an empty reel id.
      matched({ mediaId: reelA }),
      matched({ conversationId: ids.ungated }),
      matched({ mediaId: "", conversationId: ids.ungated }),
      matched({ mediaId: reelB, conversationId: ids.ungated }),
    ],
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.eventLog.deleteMany({ where: { id: { in: eventIds } } });
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.reelMeta.deleteMany({ where: { mediaId: { in: [reelA, reelB] } } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

describeWithDatabase("getLeaderboard against real Postgres", () => {
  async function rows() {
    const { getLeaderboard } = await import("./insightsService.js");
    const board = await getLeaderboard();
    return {
      a: board.find((r) => r.mediaId === reelA),
      b: board.find((r) => r.mediaId === reelB),
    };
  }

  it("reports each reel's newest snapshot, whatever order snapshots were stored in", async () => {
    const { a } = await rows();
    expect(a).toMatchObject({ views: 300, reach: 2000, skipRate: 0.4 });
  });

  it("reports nulls, not zeros, for a reel with no snapshot", async () => {
    const { b } = await rows();
    expect(b).toMatchObject({ views: null, reach: null, skipRate: null, captureRatePct: null });
  });

  it("counts distinct conversations per reel and how far each got", async () => {
    const { a, b } = await rows();
    expect(a?.conversion).toEqual({ keywordComments: 3, gateDelivered: 2, completed: 1 });
    expect(b?.conversion).toEqual({ keywordComments: 1, gateDelivered: 0, completed: 0 });
  });

  it("derives the capture rate from those counts and the newest reach", async () => {
    const { a } = await rows();
    expect(a?.captureRatePct).toBe(0.15);
  });
});
