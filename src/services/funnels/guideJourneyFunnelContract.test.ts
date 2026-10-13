// src/services/funnels/guideJourneyFunnelContract.test.ts
//
// The per-person guide journey SQL against real Postgres. Every person below is shaped like
// a production journey, because a hand-built row is how the old funnel read zero for seven
// weeks without a failing test.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuideJourneyRow } from "./guideJourneyFunnel.js";
import { fetchGuideJourneyRows, runGuideJourneyLeak } from "./runFunnel.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs);
const window = { from: at(-10 * DAY), to: at(HOUR) };
const ids = { resource: randomUUID(), keyword: randomUUID() };
const igUser = (name: string) => `ig-${suffix}-${name}`;
let db: PrismaClient;
const conversationIds: string[] = [];
const threadIds: string[] = [];

type TokenSeed = {
  action: "request_guide" | "check_follow";
  status: "active" | "consumed" | "cancelled";
};
type CardSeed = {
  source?: "dm";
  askedAt: Date;
  windowEnd: Date;
  state: "awaiting_request" | "awaiting_follow" | "delivered";
  followCheckCount?: number;
  followResponseCount?: number;
  tokens: TokenSeed[];
  deliveredAt?: Date;
  /** An outbound card in DM history, read or not. */
  logged?: { seen: boolean };
  /** An inbound DM after the card. */
  inboundAt?: Date;
};

async function seedPerson(name: string, cards: CardSeed[]) {
  const igUserId = igUser(name);
  await db.igUser.create({ data: { id: igUserId, username: `user_${suffix}_${name}`, isFollower: null } });
  let threadId: string | null = null;
  for (const card of cards) {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    await db.conversation.create({
      data: {
        id: conversationId,
        igUserId,
        keywordId: ids.keyword,
        state: card.deliveredAt ? "completed" : "awaiting_done",
        completedAt: card.deliveredAt ?? null,
        createdAt: card.askedAt,
      },
    });
    await db.eventLog.create({
      data: {
        kind: "keyword_matched",
        createdAt: card.askedAt,
        payload: { conversationId, keyword: `FGJ${suffix}`, ...(card.source ? { source: card.source } : {}) },
      },
    });
    const attemptId = randomUUID();
    await db.guideAccessAttempt.create({
      data: {
        id: attemptId,
        conversationId,
        resourceId: ids.resource,
        state: card.state,
        lastFollowResult:
          card.state === "awaiting_request"
            ? "unknown"
            : card.state === "awaiting_follow"
              ? "non_follower"
              : "follower",
        followCheckCount: card.followCheckCount ?? 0,
        followResponseCount: card.followResponseCount ?? 0,
        messagingWindowExpiresAt: card.windowEnd,
        createdAt: card.askedAt,
      },
    });
    for (const [index, token] of card.tokens.entries()) {
      const createdAt = new Date(card.askedAt.getTime() + (index + 1) * 60_000);
      await db.guideActionToken.create({
        data: {
          id: randomUUID(),
          attemptId,
          action: token.action,
          status: token.status,
          createdAt,
          expiresAt: card.windowEnd,
          consumedAt: token.status === "consumed" ? createdAt : null,
        },
      });
    }
    if (card.deliveredAt) {
      await db.eventLog.create({
        data: {
          kind: "sequence_completed",
          createdAt: card.deliveredAt,
          payload: { conversationId, followerAtDelivery: true },
        },
      });
    }
    if (card.logged || card.inboundAt) {
      if (!threadId) {
        const thread = await db.dmThread.create({
          data: { igAccountId: `acct-${suffix}`, igUserId, lastMessageAt: card.askedAt },
        });
        threadId = thread.id;
        threadIds.push(thread.id);
      }
      if (card.logged) {
        const sentAt = new Date(card.askedAt.getTime() + 30_000);
        await db.dmMessage.create({
          data: {
            threadId,
            direction: "outbound",
            type: "text",
            source: "keyword_automation",
            text: "Want me to send it here?",
            instagramTimestamp: sentAt,
            createdAt: sentAt,
            seenAt: card.logged.seen ? new Date(sentAt.getTime() + HOUR) : null,
          },
        });
      }
      if (card.inboundAt) {
        await db.dmMessage.create({
          data: {
            threadId,
            direction: "inbound",
            type: "text",
            source: "instagram_user",
            text: "thank you",
            instagramTimestamp: card.inboundAt,
            createdAt: card.inboundAt,
          },
        });
      }
    }
  }
}

const closed = (askedAt: Date) => new Date(askedAt.getTime() + DAY);
const untapped = (askedAt: Date, extra: Partial<CardSeed> = {}): CardSeed => ({
  askedAt,
  windowEnd: closed(askedAt),
  state: "awaiting_request",
  tokens: [{ action: "request_guide", status: "active" }],
  ...extra,
});
const deliveredYes = (askedAt: Date, extra: Partial<CardSeed> = {}): CardSeed => ({
  askedAt,
  windowEnd: closed(askedAt),
  state: "delivered",
  followCheckCount: 1,
  tokens: [{ action: "request_guide", status: "consumed" }],
  deliveredAt: new Date(askedAt.getTime() + HOUR),
  ...extra,
});

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({ data: { id: ids.resource, name: `Journey ${suffix}` } });
  await db.keyword.create({
    data: {
      id: ids.keyword,
      keyword: `FGJ${suffix}`,
      resourceId: ids.resource,
      publicReply: "x",
      gateMessage: "x",
      mediaId: `reel-${suffix}`,
    },
  });

  const d = (days: number) => at(-days * DAY);
  // Commented on three reels, said yes on one: one person, not lost.
  await seedPerson("multi", [deliveredYes(d(5)), untapped(d(4)), untapped(d(3))]);
  // Hit the wall on one card, then got another card's guide later: a new follower.
  await seedPerson("wallThenFollow", [
    {
      askedAt: d(5),
      windowEnd: closed(d(5)),
      state: "awaiting_follow",
      followCheckCount: 1,
      tokens: [
        { action: "request_guide", status: "consumed" },
        { action: "check_follow", status: "active" },
      ],
    },
    deliveredYes(d(3)),
  ]);
  // Asked by DM: no card, the DM is the request.
  await seedPerson("dmOnly", [deliveredYes(d(4), { source: "dm" })]);
  // Never said yes, one of each reason.
  await seedPerson("fresh", [
    untapped(at(-2 * HOUR), { windowEnd: at(22 * HOUR) }),
  ]);
  await seedPerson("wrote", [untapped(d(3), { inboundAt: new Date(d(3).getTime() + 3 * HOUR) })]);
  await seedPerson("opened", [untapped(d(3), { logged: { seen: true } })]);
  await seedPerson("unread", [untapped(d(3), { logged: { seen: false } })]);
  await seedPerson("silent", [untapped(d(3))]);
  // Stuck at the wall, both reasons.
  await seedPerson("saidFollowed", [
    {
      askedAt: d(3),
      windowEnd: closed(d(3)),
      state: "awaiting_follow",
      followCheckCount: 2,
      followResponseCount: 1,
      tokens: [
        { action: "request_guide", status: "consumed" },
        { action: "check_follow", status: "cancelled" },
        { action: "check_follow", status: "active" },
      ],
    },
  ]);
  await seedPerson("gaveUp", [
    {
      askedAt: d(3),
      windowEnd: closed(d(3)),
      state: "awaiting_follow",
      followCheckCount: 1,
      tokens: [
        { action: "request_guide", status: "consumed" },
        { action: "check_follow", status: "active" },
      ],
    },
  ]);
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.dmMessage.deleteMany({ where: { threadId: { in: threadIds } } });
  await db.dmThread.deleteMany({ where: { id: { in: threadIds } } });
  await db.guideAccessAttempt.deleteMany({ where: { conversationId: { in: conversationIds } } });
  for (const conversationId of conversationIds) {
    await db.eventLog.deleteMany({ where: { payload: { path: ["conversationId"], equals: conversationId } } });
  }
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.igUser.deleteMany({ where: { id: { startsWith: `ig-${suffix}-` } } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

describeWithDatabase("guide journey SQL, per person", () => {
  async function byName(): Promise<Map<string, GuideJourneyRow>> {
    const rows = await fetchGuideJourneyRows(db, window);
    return new Map(
      rows
        .filter((row) => row.igUserId.startsWith(`ig-${suffix}-`))
        .map((row) => [row.igUserId.slice(`ig-${suffix}-`.length), row]),
    );
  }

  it("counts a person once across their cards and does not call their untapped cards lost", async () => {
    const people = await byName();
    expect(people.size).toBe(10);
    expect(people.get("multi")).toMatchObject({
      cards: 3,
      reached: true,
      saidYes: true,
      hitWall: false,
      gotGuide: true,
      quietBucket: null,
      wallBucket: null,
    });
  });

  it("counts someone who hit the wall and later got a guide as a new follower", async () => {
    expect((await byName()).get("wallThenFollow")).toMatchObject({
      hitWall: true,
      followed: true,
      gotGuide: true,
      wallBucket: null,
    });
  });

  it("puts a DM asker past the card and into said yes", async () => {
    expect((await byName()).get("dmOnly")).toMatchObject({ reached: true, saidYes: true, hitWall: false });
  });

  it("explains every person who never said yes", async () => {
    const people = await byName();
    expect(people.get("fresh")?.quietBucket).toBe("still_has_time");
    expect(people.get("wrote")?.quietBucket).toBe("wrote_not_yes");
    expect(people.get("opened")?.quietBucket).toBe("opened_ignored");
    expect(people.get("unread")?.quietBucket).toBe("no_sign_opened");
    expect(people.get("silent")?.quietBucket).toBe("cannot_tell");
  });

  it("explains every person stuck at the wall", async () => {
    const people = await byName();
    expect(people.get("saidFollowed")).toMatchObject({ hitWall: true, followed: false, wallBucket: "said_followed" });
    expect(people.get("gaveUp")).toMatchObject({ hitWall: true, followed: false, wallBucket: "never_came_back" });
  });

  it("lists the people in a leak, and only them", async () => {
    const stuck = (await runGuideJourneyLeak(db, "stuck-at-wall", window, 500)).rows
      .filter((row) => row.igUserId.startsWith(`ig-${suffix}-`))
      .map((row) => [row.igUserId.slice(`ig-${suffix}-`.length), row.bucket]);
    expect(stuck).toEqual(
      expect.arrayContaining([
        ["saidFollowed", "said_followed"],
        ["gaveUp", "never_came_back"],
      ]),
    );
    expect(stuck.map(([name]) => name)).not.toContain("wallThenFollow");

    const quiet = (await runGuideJourneyLeak(db, "never-said-yes", window, 500)).rows
      .filter((row) => row.igUserId.startsWith(`ig-${suffix}-`))
      .map((row) => row.igUserId.slice(`ig-${suffix}-`.length));
    expect(quiet.sort()).toEqual(["fresh", "opened", "silent", "unread", "wrote"]);
  });
});
