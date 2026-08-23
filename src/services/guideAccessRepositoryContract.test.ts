import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createGuideAccessRepository,
  type GuideAccessRepository,
} from "./guideAccessRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const NOW = new Date(Date.now() + 60 * 60_000);

type Fixture = {
  conversationId: string;
  coverVersionId: string;
  resourceId: string;
  senderId: string;
};

let firstClient: PrismaClient;
let secondClient: PrismaClient;
let firstRepository: GuideAccessRepository;
let secondRepository: GuideAccessRepository;
const resourceIds = new Set<string>();

async function createFixture(): Promise<Fixture> {
  const resourceId = randomUUID();
  const keywordId = randomUUID();
  const conversationId = randomUUID();
  const coverVersionId = randomUUID();
  const senderId = `guide-access-contract-${randomUUID()}`;
  resourceIds.add(resourceId);

  await firstClient.resource.create({ data: { id: resourceId, name: `Access ${resourceId}` } });
  await firstClient.presentationCategory.create({
    data: {
      id: randomUUID(),
      slug: `access-${randomUUID()}`,
      name: `Access ${randomUUID()}`,
      collectionLabel: "GUIDE",
      defaultKicker: "TINY SOHO",
      templateKey: "bedtime_window_house_v1",
      paletteKey: "bedtime_warm_v1",
      illustrationKey: "bedtime_house_v1",
      designStatus: "ready",
      createdBy: "contract",
      updatedBy: "contract",
    },
  });
  const category = await firstClient.presentationCategory.findFirstOrThrow({
    where: { name: { startsWith: "Access " } },
    orderBy: { createdAt: "desc" },
  });
  await firstClient.resourceCoverVersion.create({
    data: {
      id: coverVersionId,
      resourceId,
      revision: 1,
      categoryId: category.id,
      templateKey: "bedtime_window_house_v1",
      paletteKey: "bedtime_warm_v1",
      illustrationKey: "bedtime_house_v1",
      kicker: "TINY SOHO",
      collectionLabel: "GUIDE",
      headline: "A calm guide",
      supportingLine: "A clear supporting line",
      closingLine: "A gentle close",
      alternativeDescription: "A warm illustrated guide cover.",
    },
  });
  await firstClient.keyword.create({
    data: {
      id: keywordId,
      keyword: `access-${randomUUID()}`,
      resourceId,
      publicReply: "reply",
      gateMessage: "gate",
      active: false,
    },
  });
  await firstClient.conversation.create({
    data: { id: conversationId, igUserId: senderId, keywordId },
  });
  return { conversationId, coverVersionId, resourceId, senderId };
}

async function createAttempt(
  fixture: Fixture,
  messagingWindowExpiresAt = new Date(NOW.getTime() + 24 * 60 * 60_000),
) {
  const result = await firstRepository.createOrLoadAttempt({
    conversationId: fixture.conversationId,
    resourceId: fixture.resourceId,
    coverVersionId: fixture.coverVersionId,
    messagingWindowExpiresAt,
  });
  return result.attempt;
}

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(LOOPBACK_HOSTS).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  firstClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  secondClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  firstRepository = createGuideAccessRepository({ database: firstClient });
  secondRepository = createGuideAccessRepository({ database: secondClient });
});

afterEach(async () => {
  if (!databaseUrl || resourceIds.size === 0) return;
  const ids = [...resourceIds];
  await firstClient.guideAccessAttempt.deleteMany({ where: { resourceId: { in: ids } } });
  await firstClient.conversation.deleteMany({ where: { keyword: { resourceId: { in: ids } } } });
  await firstClient.keyword.deleteMany({ where: { resourceId: { in: ids } } });
  await firstClient.resourceCoverVersion.deleteMany({ where: { resourceId: { in: ids } } });
  await firstClient.resource.deleteMany({ where: { id: { in: ids } } });
  await firstClient.presentationCategory.deleteMany({
    where: { createdBy: "contract", coverVersions: { none: {} } },
  });
  resourceIds.clear();
});

afterAll(async () => {
  await Promise.all([firstClient?.$disconnect(), secondClient?.$disconnect()]);
});

describeWithDatabase("guide access repository PostgreSQL concurrency contract", () => {
  it("collapses concurrent attempt creation and preserves the winning immutable snapshot", async () => {
    const fixture = await createFixture();
    const input = {
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      coverVersionId: fixture.coverVersionId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    };

    const [left, right] = await Promise.all([
      firstRepository.createOrLoadAttempt(input),
      secondRepository.createOrLoadAttempt(input),
    ]);

    expect(left.attempt.id).toBe(right.attempt.id);
    expect(left.attempt).toMatchObject(input);
    expect(right.attempt).toMatchObject(input);
    await expect(
      firstClient.guideAccessAttempt.count({ where: { conversationId: fixture.conversationId } }),
    ).resolves.toBe(1);
  });

  it("expires a time-closed row before creating the next active attempt", async () => {
    const fixture = await createFixture();
    const first = await createAttempt(fixture, NOW);

    const replay = await firstRepository.createOrLoadAttempt({
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      coverVersionId: fixture.coverVersionId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      now: NOW,
    });

    expect(replay.kind).toBe("created");
    expect(replay.attempt.id).not.toBe(first.id);
    await expect(
      firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: first.id } }),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("collapses concurrent token issue to one opaque active token", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    const input = {
      attemptId: attempt.id,
      action: "request_guide" as const,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    };

    const [left, right] = await Promise.all([
      firstRepository.issueToken(input),
      secondRepository.issueToken(input),
    ]);

    expect([left.kind, right.kind].sort()).toEqual(["issued", "replayed"]);
    if (!("token" in left) || !("token" in right)) throw new Error("expected tokens");
    expect(left.token.id).toBe(right.token.id);
    await expect(
      firstClient.guideActionToken.count({ where: { attemptId: attempt.id, status: "active" } }),
    ).resolves.toBe(1);
  });

  it("lets exactly one duplicate action consume the token and claim checking", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    const issued = await firstRepository.issueToken({
      attemptId: attempt.id,
      action: "request_guide",
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    if (!("token" in issued)) throw new Error("expected token");
    const input = {
      tokenId: issued.token.id,
      action: "request_guide" as const,
      senderId: fixture.senderId,
      now: new Date(NOW.getTime() + 1_000),
    };

    const results = await Promise.all([
      firstRepository.consumeToken(input),
      secondRepository.consumeToken(input),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already_consumed", "consumed"]);
    await expect(firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).resolves.toMatchObject({
      state: "checking_follow",
      followCheckCount: 1,
    });
    await expect(firstClient.guideActionToken.findUniqueOrThrow({ where: { id: issued.token.id } })).resolves.toMatchObject({
      status: "consumed",
      consumedAt: input.now,
    });
  });

  it("expires token consumption at the exact messaging-window boundary", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture, NOW);
    const issued = await firstRepository.issueToken({
      attemptId: attempt.id,
      action: "request_guide",
      now: new Date(NOW.getTime() - 1),
      expiresAt: NOW,
    });
    if (!("token" in issued)) throw new Error("expected token");

    await expect(
      firstRepository.consumeToken({
        tokenId: issued.token.id,
        action: "request_guide",
        senderId: fixture.senderId,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "expired" });
    await expect(
      firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ state: "expired", followCheckCount: 0 });
    await expect(
      firstClient.guideActionToken.findUniqueOrThrow({ where: { id: issued.token.id } }),
    ).resolves.toMatchObject({ status: "expired", consumedAt: null });
  });

  it("lets exactly one duplicate state transition win", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    await firstRepository.beginChecking({
      attemptId: attempt.id,
      expectedState: "awaiting_request",
      now: NOW,
    });

    const results = await Promise.all([
      firstRepository.markAwaitingFollow({
        attemptId: attempt.id,
        expectedState: "checking_follow",
        checkedAt: NOW,
        now: NOW,
      }),
      secondRepository.markDelivering({
        attemptId: attempt.id,
        expectedState: "checking_follow",
        checkedAt: NOW,
        now: NOW,
      }),
    ]);

    expect(results.filter((result) => result.kind === "transitioned")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "state_conflict")).toHaveLength(1);
  });

  it("reserves only two automatic responses under a three-way race", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    await firstRepository.beginChecking({
      attemptId: attempt.id,
      expectedState: "awaiting_request",
      now: NOW,
    });
    await firstRepository.markAwaitingFollow({
      attemptId: attempt.id,
      expectedState: "checking_follow",
      checkedAt: NOW,
      now: NOW,
    });

    const repositories = [firstRepository, secondRepository, firstRepository];
    const results = await Promise.all(
      repositories.map((repository) =>
        repository.reserveFollowResponse({
          attemptId: attempt.id,
          expectedState: "awaiting_follow",
          now: NOW,
        }),
      ),
    );

    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(2);
    expect(results.filter((result) => result.kind === "limit_reached")).toHaveLength(1);
    await expect(firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).resolves.toMatchObject({
      followResponseCount: 2,
    });
  });

  it("expires direct checking at the exact messaging-window boundary", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture, NOW);

    await expect(
      firstRepository.beginChecking({
        attemptId: attempt.id,
        expectedState: "awaiting_request",
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "expired", attempt: { state: "expired" } });
    await expect(
      firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ state: "expired", followCheckCount: 0 });
  });

  it.each(["markAwaitingFollow", "markDelivering"] as const)(
    "expires %s at the exact post-check boundary",
    async (method) => {
      const fixture = await createFixture();
      const attempt = await createAttempt(fixture, NOW);
      await firstRepository.beginChecking({
        attemptId: attempt.id,
        expectedState: "awaiting_request",
        now: new Date(NOW.getTime() - 1),
      });

      await expect(
        firstRepository[method]({
          attemptId: attempt.id,
          expectedState: "checking_follow",
          checkedAt: new Date(NOW.getTime() - 1),
          now: NOW,
        }),
      ).resolves.toMatchObject({ kind: "expired", attempt: { state: "expired" } });
      await expect(
        firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).resolves.toMatchObject({ state: "expired", lastFollowResult: "unknown" });
    },
  );

  it("expires automatic-response reservation at the exact messaging-window boundary", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture, NOW);
    await firstRepository.beginChecking({
      attemptId: attempt.id,
      expectedState: "awaiting_request",
      now: new Date(NOW.getTime() - 2),
    });
    await firstRepository.markAwaitingFollow({
      attemptId: attempt.id,
      expectedState: "checking_follow",
      checkedAt: new Date(NOW.getTime() - 1),
      now: new Date(NOW.getTime() - 1),
    });

    await expect(
      firstRepository.reserveFollowResponse({
        attemptId: attempt.id,
        expectedState: "awaiting_follow",
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "expired", attempt: { state: "expired" } });
    await expect(
      firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ state: "expired", followResponseCount: 0 });
  });
});
