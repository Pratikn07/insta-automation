// src/services/funnels/guideFollowFunnelContract.test.ts
//
// The V2 guide path (card gate, live on every guide since 2026-08-24) records a journey
// in guide_access_attempt and guide_action_token, and never writes the dm_sent/gate,
// done_received or follow_required events the funnel was built on. These run the real
// SQL against Postgres, because a mocked row shape is exactly how the funnel read
// "Got the unlock DM: 1" for seven weeks without a single failing test.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOLLOW_THROUGH_DUE_SQL } from "../followThroughCore.js";
import { fetchGuideFollowRows, runDropOff } from "./runFunnel.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const DAY_MS = 24 * 60 * 60 * 1000;
const window = { from: new Date(Date.now() - 60 * 60 * 1000), to: new Date(Date.now() + 60 * 60 * 1000) };
const ids = {
  resource: randomUUID(),
  keyword: randomUUID(),
  untapped: randomUUID(),
  tappedFollower: randomUUID(),
  stuckAtWall: randomUUID(),
  clearedWall: randomUUID(),
  dmEntry: randomUUID(),
};
const conversations = [
  ids.untapped,
  ids.tappedFollower,
  ids.stuckAtWall,
  ids.clearedWall,
  ids.dmEntry,
] as const;
const igUserFor = (conversationId: string) => `ig-${suffix}-${conversationId.slice(0, 8)}`;
let db: PrismaClient;

type TokenSeed = { action: "request_guide" | "check_follow"; status: "active" | "consumed" | "cancelled" };

async function seedJourney(input: {
  conversationId: string;
  source?: "dm";
  attemptState: "awaiting_request" | "awaiting_follow" | "delivered";
  followCheckCount: number;
  followResponseCount?: number;
  tokens: TokenSeed[];
  delivered: boolean;
  completedAt?: Date;
  followRecheckedAt?: Date;
}) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + DAY_MS);
  await db.igUser.create({ data: { id: igUserFor(input.conversationId), isFollower: true } });
  await db.conversation.create({
    data: {
      id: input.conversationId,
      igUserId: igUserFor(input.conversationId),
      keywordId: ids.keyword,
      state: input.delivered ? "completed" : "awaiting_done",
      completedAt: input.completedAt ?? (input.delivered ? now : null),
      followRecheckedAt: input.followRecheckedAt ?? null,
    },
  });
  await db.eventLog.create({
    data: {
      kind: "keyword_matched",
      payload: {
        conversationId: input.conversationId,
        keyword: `FGV${suffix}`,
        ...(input.source ? { source: input.source } : {}),
      },
    },
  });
  const attemptId = randomUUID();
  await db.guideAccessAttempt.create({
    data: {
      id: attemptId,
      conversationId: input.conversationId,
      resourceId: ids.resource,
      state: input.attemptState,
      lastFollowResult:
        input.attemptState === "awaiting_request"
          ? "unknown"
          : input.attemptState === "awaiting_follow"
            ? "non_follower"
            : "follower",
      followCheckCount: input.followCheckCount,
      followResponseCount: input.followResponseCount ?? 0,
      messagingWindowExpiresAt: windowEnd,
    },
  });
  for (const token of input.tokens) {
    await db.guideActionToken.create({
      data: {
        id: randomUUID(),
        attemptId,
        action: token.action,
        status: token.status,
        expiresAt: windowEnd,
        consumedAt: token.status === "consumed" ? now : null,
      },
    });
  }
  if (input.delivered) {
    await db.eventLog.create({
      data: {
        kind: "sequence_completed",
        payload: {
          conversationId: input.conversationId,
          // What every V2 delivery carries: the strict journey only delivers after a
          // follow is confirmed, which is why the V1 convert pool went empty.
          followerAtDelivery: true,
        },
      },
    });
  }
}

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({ data: { id: ids.resource, name: `Funnel V2 ${suffix}` } });
  await db.keyword.create({
    data: {
      id: ids.keyword,
      keyword: `FGV${suffix}`,
      resourceId: ids.resource,
      publicReply: "x",
      gateMessage: "x",
      mediaId: `reel-${suffix}`,
    },
  });

  const longAgo = new Date(Date.now() - 30 * DAY_MS);
  // Opening card sent, never tapped.
  await seedJourney({
    conversationId: ids.untapped,
    attemptState: "awaiting_request",
    followCheckCount: 0,
    tokens: [{ action: "request_guide", status: "active" }],
    delivered: false,
  });
  // Tapped, already following, served immediately. Completed long ago so the
  // follow-through query has a non-convert to wrongly pick up.
  await seedJourney({
    conversationId: ids.tappedFollower,
    attemptState: "delivered",
    followCheckCount: 1,
    tokens: [{ action: "request_guide", status: "consumed" }],
    delivered: true,
    completedAt: longAgo,
    followRecheckedAt: longAgo,
  });
  // Tapped, shown the follow wall, re-asked once, never cleared it.
  await seedJourney({
    conversationId: ids.stuckAtWall,
    attemptState: "awaiting_follow",
    followCheckCount: 2,
    followResponseCount: 1,
    tokens: [
      { action: "request_guide", status: "consumed" },
      { action: "check_follow", status: "cancelled" },
      { action: "check_follow", status: "active" },
    ],
    delivered: false,
  });
  // Hit the wall once, followed, got the guide 30 days ago: a convert due a 21-day reading.
  await seedJourney({
    conversationId: ids.clearedWall,
    attemptState: "delivered",
    followCheckCount: 2,
    tokens: [
      { action: "request_guide", status: "consumed" },
      { action: "check_follow", status: "consumed" },
    ],
    delivered: true,
    completedAt: longAgo,
    followRecheckedAt: longAgo,
  });
  // DM'd the keyword: no opening card exists, the DM itself was the request.
  await seedJourney({
    conversationId: ids.dmEntry,
    source: "dm",
    attemptState: "delivered",
    followCheckCount: 1,
    tokens: [{ action: "request_guide", status: "consumed" }],
    delivered: true,
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.guideAccessAttempt.deleteMany({ where: { conversationId: { in: [...conversations] } } });
  for (const conversationId of conversations) {
    await db.eventLog.deleteMany({
      where: { payload: { path: ["conversationId"], equals: conversationId } },
    });
  }
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.igUser.deleteMany({ where: { id: { in: conversations.map(igUserFor) } } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

describeWithDatabase("guide → follow cohort SQL on the V2 guide path", () => {
  async function rowsById() {
    const rows = await fetchGuideFollowRows(db, window);
    return new Map(rows.filter((r) => conversations.includes(r.conversationId as never)).map((r) => [r.conversationId, r]));
  }

  it("counts a comment-path access attempt as a delivered unlock DM, and a DM entry as no unlock DM", async () => {
    const rows = await rowsById();
    expect(rows.size).toBe(5);
    expect(rows.get(ids.untapped)).toMatchObject({ gateSent: true, doneReceived: false, guideDelivered: false });
    expect(rows.get(ids.tappedFollower)).toMatchObject({ gateSent: true, doneReceived: true });
    expect(rows.get(ids.dmEntry)).toMatchObject({ entryPath: "dm", gateSent: false, doneReceived: true });
  });

  it("counts one follow ask per check_follow token, so a re-ask reads as a second ask", async () => {
    const rows = await rowsById();
    expect(rows.get(ids.untapped)?.followRequiredCount).toBe(0);
    expect(rows.get(ids.tappedFollower)?.followRequiredCount).toBe(0);
    expect(rows.get(ids.stuckAtWall)).toMatchObject({ followRequiredCount: 2, doneReceived: true, guideDelivered: false });
    expect(rows.get(ids.clearedWall)).toMatchObject({ followRequiredCount: 1, guideDelivered: true });
  });

  it("marks a wall-clearer past 21 days as due a follow-through reading, and nobody else", async () => {
    const rows = await rowsById();
    expect(rows.get(ids.clearedWall)?.followThroughDue).toBe(true);
    // Completed just as long ago, but never had to follow: the worker never reads them.
    expect(rows.get(ids.tappedFollower)?.followThroughDue).toBe(false);
    expect(rows.get(ids.stuckAtWall)?.followThroughDue).toBe(false);
  });

  it("puts the untapped opening in the no-reply leak and the re-asked parent at the wall", async () => {
    const noReply = (await runDropOff(db, "no-reply", window, 500)).rows.map((r) => r.conversationId);
    expect(noReply).toContain(ids.untapped);
    for (const id of [ids.tappedFollower, ids.stuckAtWall, ids.clearedWall, ids.dmEntry]) {
      expect(noReply).not.toContain(id);
    }

    const stuck = (await runDropOff(db, "stuck-at-wall", window, 500)).rows;
    expect(stuck.map((r) => r.conversationId)).toContain(ids.stuckAtWall);
    expect(stuck.find((r) => r.conversationId === ids.stuckAtWall)?.wallAsks).toBe(2);
    expect(stuck.map((r) => r.conversationId)).not.toContain(ids.clearedWall);
  });

  it("gives the follow-through worker the V2 convert and not the parent who was already following", async () => {
    const due = await db.$queryRawUnsafe<{ ig_user_id: string }[]>(
      FOLLOW_THROUGH_DUE_SQL,
      new Date(Date.now() - 21 * DAY_MS),
      500,
    );
    const users = due.map((d) => d.ig_user_id);
    expect(users).toContain(igUserFor(ids.clearedWall));
    expect(users).not.toContain(igUserFor(ids.tappedFollower));
  });
});
