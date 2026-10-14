// src/api/linkRedirectContract.test.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLinkRedirectRouter } from "./linkRedirect.routes.js";
import { createLinkGuideRepository } from "../services/linkGuideRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = {
  resource: randomUUID(),
  keyword: randomUUID(),
  human: randomUUID(),
  bot: randomUUID(),
  twice: randomUUID(),
  twiceIntent: randomUUID(),
};
const tokens = { human: `h${suffix}AB`, bot: `x${suffix}AB`, twice: `t${suffix}AB` };
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0.0";
const backgroundErrors: unknown[] = [];
let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Redirect link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: { id: ids.keyword, keyword: `RDR${suffix}`, resourceId: ids.resource, publicReply: "x", gateMessage: "x", mediaId: `reel-${suffix}` },
  });
  for (const [key, conversationId] of [["human", ids.human], ["bot", ids.bot], ["twice", ids.twice]] as const) {
    await db.conversation.create({
      data: { id: conversationId, igUserId: `ig-${suffix}-${key}`, keywordId: ids.keyword, state: "link_sent" },
    });
    await db.guideLinkSend.create({
      data: {
        token: tokens[key],
        conversationId,
        resourceId: ids.resource,
        keywordId: ids.keyword,
        mediaId: `reel-${suffix}`,
        igUserId: `ig-${suffix}-${key}`,
        channel: "private_reply",
        shape: "card",
        status: "sent",
        sentAt: new Date(),
      },
    });
  }
  // A comment-path link conversation owns an open journey intent; completion closes it.
  const windowStartedAt = new Date();
  await db.journeyIntent.create({
    data: {
      id: ids.twiceIntent,
      igUserId: `ig-${suffix}-twice`,
      keywordId: ids.keyword,
      canonicalConversationId: ids.twice,
      windowStartedAt,
      lastTriggerAt: windowStartedAt,
      windowExpiresAt: new Date(windowStartedAt.getTime() + 48 * 60 * 60 * 1000),
    },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.journeyIntent.deleteMany({ where: { keywordId: ids.keyword } });
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

async function app() {
  const { markCompleted } = await import("../services/conversationService.js");
  const value = express();
  value.use(
    "/r",
    createLinkRedirectRouter({
      repository: createLinkGuideRepository(db),
      allowedHosts: () => new Set(["mycuratedhaven.com"]),
      completeConversation: markCompleted,
      now: () => new Date(),
      // Collected, not thrown: the handler calls this after the response is sent.
      onBackgroundError: (error) => {
        backgroundErrors.push(error);
      },
    }),
  );
  return value;
}

describeWithDatabase("link redirect against the real database", () => {
  it("records a human tap and completes the link_sent conversation", async () => {
    const response = await request(await app())
      .get(`/r/${tokens.human}`)
      .set("User-Agent", INSTAGRAM_UA)
      .expect(302);

    expect(response.headers.location).toBe(
      `https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm&utm_content=reel-${suffix.toLowerCase()}`,
    );
    await vi.waitFor(async () => {
      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: ids.human } });
      expect(conversation.state).toBe("completed");
    });
    await expect(
      db.guideLinkClick.findMany({ where: { send: { token: tokens.human } }, select: { isBot: true, uaFamily: true } }),
    ).resolves.toEqual([{ isBot: false, uaFamily: "instagram_app" }]);
    expect(backgroundErrors).toEqual([]);
  });

  it("records a preview bot and leaves the conversation in link_sent", async () => {
    await request(await app()).get(`/r/${tokens.bot}`).set("User-Agent", "facebookexternalhit/1.1").expect(302);

    await vi.waitFor(async () => {
      await expect(db.guideLinkClick.count({ where: { send: { token: tokens.bot } } })).resolves.toBe(1);
    });
    await expect(db.conversation.findUniqueOrThrow({ where: { id: ids.bot } })).resolves.toMatchObject({
      state: "link_sent",
    });
  });

  // Owner ruling (Task 6): recordClick's first-human check is not atomic, so two
  // simultaneous first taps can both complete the conversation. Completion must be
  // idempotent: the second one changes nothing a parent or a funnel can see.
  it("treats completing a link_sent conversation twice, as two simultaneous first taps do, as harmless", async () => {
    const { markCompleted } = await import("../services/conversationService.js");
    const server = await app();

    // Two simultaneous human taps through the real route: both redirect, neither errors.
    const responses = await Promise.all(
      [0, 1].map(() => request(server).get(`/r/${tokens.twice}`).set("User-Agent", INSTAGRAM_UA)),
    );
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    await vi.waitFor(async () => {
      await expect(db.guideLinkClick.count({ where: { send: { token: tokens.twice } } })).resolves.toBe(2);
      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: ids.twice } });
      expect(conversation.state).toBe("completed");
    });

    // Whichever of the taps won the first-human race above, run the double completion
    // itself deterministically: two at once, then one more later.
    await expect(Promise.all([markCompleted(ids.twice), markCompleted(ids.twice)])).resolves.toHaveLength(2);
    const afterRace = await db.conversation.findUniqueOrThrow({ where: { id: ids.twice } });
    const intentAfterRace = await db.journeyIntent.findUniqueOrThrow({ where: { id: ids.twiceIntent } });
    expect(afterRace.state).toBe("completed");
    expect(afterRace.completedAt).not.toBeNull();
    expect(intentAfterRace.completedAt).not.toBeNull();

    await markCompleted(ids.twice);
    // An earlier completion is never moved forward, so the intent and conversation keep
    // the time of the tap that completed them.
    await expect(db.conversation.findUniqueOrThrow({ where: { id: ids.twice } })).resolves.toMatchObject({
      state: "completed",
      completedAt: afterRace.completedAt,
    });
    await expect(db.journeyIntent.findUniqueOrThrow({ where: { id: ids.twiceIntent } })).resolves.toMatchObject({
      completedAt: intentAfterRace.completedAt,
    });
    // Link completion never claims a guide delivery, so the gated funnel is untouched.
    await expect(
      db.eventLog.count({
        where: { kind: "sequence_completed", payload: { path: ["conversationId"], equals: ids.twice } },
      }),
    ).resolves.toBe(0);
    expect(backgroundErrors).toEqual([]);
  });
});
