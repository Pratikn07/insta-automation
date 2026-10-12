import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLinkGuideRepository, type LinkGuideRepository } from "./linkGuideRepository.js";
import { MAX_RECORDED_CLICKS_PER_SEND } from "./linkGuidePolicy.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = { resource: randomUUID(), keyword: randomUUID(), conversation: randomUUID() };
let db: PrismaClient;
let repository: LinkGuideRepository;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repository = createLinkGuideRepository(db);
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Repo link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: {
      id: ids.keyword,
      keyword: `RPO${suffix}`,
      resourceId: ids.resource,
      publicReply: "x",
      gateMessage: "x",
      mediaId: `reel-${suffix}`,
    },
  });
  await db.conversation.create({
    data: { id: ids.conversation, igUserId: `ig-${suffix}`, keywordId: ids.keyword, state: "link_sent" },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

function newSend(token: string) {
  return repository.createSend({
    token,
    conversationId: ids.conversation,
    resourceId: ids.resource,
    keywordId: ids.keyword,
    mediaId: `reel-${suffix}`,
    igUserId: `ig-${suffix}`,
    channel: "private_reply",
    shape: "card",
  });
}

describeWithDatabase("link guide repository", () => {
  it("finds a send by token with the guide's current link and the conversation state", async () => {
    const token = `a${suffix}AB`;
    const send = await newSend(token);
    await repository.markSendSent(send.id, "mid-1", new Date());

    await expect(repository.findForRedirect(token)).resolves.toEqual({
      id: send.id,
      conversationId: ids.conversation,
      mediaId: `reel-${suffix}`,
      conversationState: "link_sent",
      resource: { name: `Repo link ${suffix}`, linkUrl: "https://mycuratedhaven.com/halloween" },
    });
    await expect(repository.findForRedirect("zzzzzzzzzzz")).resolves.toBeNull();
  });

  it("reports only the first human click as first, whatever bots did before", async () => {
    const send = await newSend(`b${suffix}AB`);
    const base = { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", clickedAt: new Date() };

    await expect(repository.recordClick({ ...base, isBot: true, uaFamily: "meta_preview" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: false,
    });
    await expect(repository.recordClick({ ...base, isBot: false, uaFamily: "instagram_app" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: true,
    });
    await expect(repository.recordClick({ ...base, isBot: false, uaFamily: "instagram_app" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: false,
    });
  });

  it("stops recording at the per-send cap without throwing", async () => {
    const send = await newSend(`c${suffix}AB`);
    const click = {
      sendId: send.id,
      destinationUrl: "https://mycuratedhaven.com/halloween",
      clickedAt: new Date(),
      isBot: true,
      uaFamily: "bot",
    };
    for (let i = 0; i < MAX_RECORDED_CLICKS_PER_SEND; i++) await repository.recordClick(click);

    await expect(repository.recordClick(click)).resolves.toEqual({ recorded: false, firstHumanClick: false });
    await expect(db.guideLinkClick.count({ where: { sendId: send.id } })).resolves.toBe(
      MAX_RECORDED_CLICKS_PER_SEND,
    );
  });

  it("marks the latest failed send as sent when its text retry lands", async () => {
    const send = await newSend(`d${suffix}AB`);
    await repository.markSendFailed(send.id);

    await expect(repository.markLatestFailedSendSent(ids.conversation, "mid-retry", new Date())).resolves.toBe(true);
    await expect(db.guideLinkSend.findUniqueOrThrow({ where: { id: send.id } })).resolves.toMatchObject({
      status: "sent",
      shape: "text",
      providerMessageId: "mid-retry",
    });
    await expect(repository.markLatestFailedSendSent(ids.conversation, "mid-x", new Date())).resolves.toBe(false);
  });

  it("lets only one of two concurrent retries claim the same failed send", async () => {
    const send = await newSend(`e${suffix}AB`);
    await repository.markSendFailed(send.id);
    const providerIds = ["mid-a", "mid-b"];

    // Hold both retries after their lookup, so they race on the write instead of the lookup.
    let lookups = 0;
    let openWrites!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => (openWrites = resolve));
    const racing = createLinkGuideRepository({
      guideLinkSend: {
        findFirst: async (args: Parameters<typeof db.guideLinkSend.findFirst>[0]) => {
          const row = await db.guideLinkSend.findFirst(args);
          lookups += 1;
          if (lookups === providerIds.length) openWrites();
          await bothLookedUp;
          return row;
        },
        update: (args: Parameters<typeof db.guideLinkSend.update>[0]) => db.guideLinkSend.update(args),
        updateMany: (args: Parameters<typeof db.guideLinkSend.updateMany>[0]) => db.guideLinkSend.updateMany(args),
      },
    } as unknown as PrismaClient);

    const results = await Promise.all(
      providerIds.map((providerId) => racing.markLatestFailedSendSent(ids.conversation, providerId, new Date())),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(db.guideLinkSend.findUniqueOrThrow({ where: { id: send.id } })).resolves.toMatchObject({
      status: "sent",
      shape: "text",
      providerMessageId: providerIds[results.indexOf(true)],
    });
  });
});
