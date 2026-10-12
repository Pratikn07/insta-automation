// src/services/funnels/linkClickFunnelContract.test.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchGuideFollowRows, fetchLinkClickRows } from "./runFunnel.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = { resource: randomUUID(), keyword: randomUUID(), clicked: randomUUID(), botOnly: randomUUID() };
const window = { from: new Date(Date.now() - 60 * 60 * 1000), to: new Date(Date.now() + 60 * 60 * 1000) };
let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Funnel link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: { id: ids.keyword, keyword: `FNL${suffix}`, resourceId: ids.resource, publicReply: "x", gateMessage: "x", mediaId: `reel-${suffix}` },
  });
  for (const [conversationId, state, humanClick] of [
    [ids.clicked, "completed", true],
    [ids.botOnly, "link_sent", false],
  ] as const) {
    await db.conversation.create({
      data: { id: conversationId, igUserId: `ig-${suffix}-${state}`, keywordId: ids.keyword, state },
    });
    await db.eventLog.create({
      data: {
        kind: "keyword_matched",
        payload: { conversationId, keyword: `FNL${suffix}`, mediaId: `reel-${suffix}`, deliveryMode: "link" },
      },
    });
    const send = await db.guideLinkSend.create({
      data: {
        token: randomUUID().replace(/-/g, "").slice(0, 11),
        conversationId,
        resourceId: ids.resource,
        keywordId: ids.keyword,
        mediaId: `reel-${suffix}`,
        igUserId: `ig-${suffix}-${state}`,
        channel: "private_reply",
        shape: "card",
        status: "sent",
        sentAt: new Date(),
      },
    });
    await db.guideLinkClick.create({
      data: { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", isBot: true, uaFamily: "meta_preview" },
    });
    if (humanClick) {
      await db.guideLinkClick.create({
        data: { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", isBot: false, uaFamily: "instagram_app" },
      });
    }
  }
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.eventLog.deleteMany({
    where: { kind: "keyword_matched", payload: { path: ["keyword"], equals: `FNL${suffix}` } },
  });
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

describeWithDatabase("link click funnel SQL", () => {
  it("counts a human tap and ignores a send that only a bot opened", async () => {
    const rows = (await fetchLinkClickRows(db, window)).filter((row) =>
      [ids.clicked, ids.botOnly].includes(row.conversationId),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: ids.clicked, mediaId: `reel-${suffix}`, linkSent: true, clicked: true }),
        expect.objectContaining({ conversationId: ids.botOnly, mediaId: `reel-${suffix}`, linkSent: true, clicked: false }),
      ]),
    );
  });

  it("keeps link guides out of the guide → follow cohort", async () => {
    const conversationIds = (await fetchGuideFollowRows(db, window)).map((row) => row.conversationId);
    expect(conversationIds).not.toContain(ids.clicked);
    expect(conversationIds).not.toContain(ids.botOnly);
  });
});
