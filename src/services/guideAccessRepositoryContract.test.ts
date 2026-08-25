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


/**
 * The fixture cover is deliberately left as a draft, so a test must opt in.
 *
 * Publishing is heavily constrained by design and all of it has to be satisfied at once:
 * `resource_cover_version_approval_check` demands approval evidence,
 * `..._published_check` demands an edition number, a content hash and a published-by,
 * and `..._ready_render_check` demands the DM path equal
 * `guide-cover/{resource_id}/{id}/{content_hash}/dm.png` exactly. The path is therefore
 * derived, never chosen.
 */
async function publishFixtureCover(fixture: Fixture, contentHash = "f".repeat(64)) {
  const dmStoragePath = `guide-cover/${fixture.resourceId}/${fixture.coverVersionId}/${contentHash}/dm.png`;
  await firstClient.resourceCoverVersion.update({
    where: { id: fixture.coverVersionId },
    data: {
      status: "published",
      renderStatus: "ready",
      editionNumber: 1,
      contentHash,
      dmStoragePath,
      approvedAt: NOW,
      approvedBy: "contract",
      publishedAt: NOW,
      publishedBy: "contract",
    },
  });
  return dmStoragePath;
}

async function createAttempt(
  fixture: Fixture,
  messagingWindowExpiresAt = new Date(NOW.getTime() + 24 * 60 * 60_000),
) {
  const result = await firstRepository.createOrLoadAttempt({
    conversationId: fixture.conversationId,
    resourceId: fixture.resourceId,
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
        messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    };

    const [left, right] = await Promise.all([
      firstRepository.createOrLoadAttempt(input),
      secondRepository.createOrLoadAttempt(input),
    ]);

    expect(left.attempt.id).toBe(right.attempt.id);
    expect(left.attempt).toMatchObject(input);
    expect(right.attempt).toMatchObject(input);
    // Deliberately no cover assertions here: the fixture cover is a draft, so both
    // sides are null and any comparison would pass without proving anything. The real
    // concurrent-snapshot proof publishes first — see "resolves exactly one cover
    // snapshot across two concurrent creators".
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
      eventAt: new Date(NOW.getTime() + 1_000),
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

  it("uses provider event time when webhook processing crosses the window boundary", async () => {
    const fixture = await createFixture();
    const windowExpiresAt = new Date(NOW.getTime() + 10 * 60_000);
    const attempt = await createAttempt(fixture, windowExpiresAt);
    const issued = await firstRepository.issueToken({
      attemptId: attempt.id,
      action: "request_guide",
      now: NOW,
      expiresAt: windowExpiresAt,
    });
    if (!("token" in issued)) throw new Error("expected token");
    const processingAt = new Date(windowExpiresAt.getTime() + 60_000);

    await expect(
      firstRepository.consumeToken({
        tokenId: issued.token.id,
        action: "request_guide",
        senderId: fixture.senderId,
        eventAt: new Date(windowExpiresAt.getTime() - 1),
        now: processingAt,
      }),
    ).resolves.toMatchObject({ kind: "consumed" });
    await expect(
      firstClient.guideActionToken.findUniqueOrThrow({ where: { id: issued.token.id } }),
    ).resolves.toMatchObject({ status: "consumed", consumedAt: processingAt });
  });

  it("claims one direct inbound UUID exactly once under concurrent replay", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    const inboundMessageId = randomUUID();
    const input = { attemptId: attempt.id, inboundMessageId, now: NOW };

    const results = await Promise.all([
      firstRepository.claimDirectInbound(input),
      secondRepository.claimDirectInbound(input),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "already_consumed",
      "consumed",
    ]);
    await expect(
      firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ state: "checking_follow", followCheckCount: 1 });
    await expect(
      firstClient.guideActionToken.findUniqueOrThrow({ where: { id: inboundMessageId } }),
    ).resolves.toMatchObject({
      attemptId: attempt.id,
      action: "request_guide",
      status: "consumed",
      consumedAt: NOW,
    });
  });

  it("rotates a follow token and makes the previous opaque token unspendable", async () => {
    const fixture = await createFixture();
    const attempt = await createAttempt(fixture);
    const directClaim = await firstRepository.claimDirectInbound({
      attemptId: attempt.id,
      inboundMessageId: randomUUID(),
      now: NOW,
    });
    if (directClaim.kind !== "consumed") throw new Error("expected direct claim");

    const firstToken = await firstRepository.replaceToken({
      attemptId: attempt.id,
      action: "check_follow",
      expectedState: "checking_follow",
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    if (firstToken.kind !== "issued") throw new Error("expected first replacement");
    await firstRepository.markAwaitingFollow({
      attemptId: attempt.id,
      expectedState: "checking_follow",
      checkedAt: NOW,
      now: NOW,
    });
    const secondClaim = await firstRepository.claimDirectInbound({
      attemptId: attempt.id,
      inboundMessageId: randomUUID(),
      now: new Date(NOW.getTime() + 1_000),
    });
    if (secondClaim.kind !== "consumed") throw new Error("expected second direct claim");

    const secondToken = await firstRepository.replaceToken({
      attemptId: attempt.id,
      action: "check_follow",
      expectedState: "checking_follow",
      now: new Date(NOW.getTime() + 1_000),
      expiresAt: new Date(NOW.getTime() + 11 * 60_000),
    });
    if (secondToken.kind !== "issued") throw new Error("expected second replacement");

    expect(secondToken.token.id).not.toBe(firstToken.token.id);
    await expect(
      firstClient.guideActionToken.findUniqueOrThrow({ where: { id: firstToken.token.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      firstClient.guideActionToken.findUniqueOrThrow({ where: { id: secondToken.token.id } }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      firstRepository.consumeToken({
        tokenId: firstToken.token.id,
        action: "check_follow",
        senderId: fixture.senderId,
        eventAt: new Date(NOW.getTime() + 2_000),
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).resolves.toEqual({ kind: "expired" });
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
        eventAt: NOW,
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

  it("reserves only three automatic responses under a four-way race", async () => {
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

    const repositories = [
      firstRepository,
      secondRepository,
      firstRepository,
      secondRepository,
    ];
    const results = await Promise.all(
      repositories.map((repository) =>
        repository.reserveFollowResponse({
          attemptId: attempt.id,
          expectedState: "awaiting_follow",
          now: NOW,
        }),
      ),
    );

    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(3);
    expect(results.filter((result) => result.kind === "limit_reached")).toHaveLength(1);
    await expect(firstClient.guideAccessAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).resolves.toMatchObject({
      followResponseCount: 3,
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

  // Parent-delivery Task 2. Real PostgreSQL is the only place the published predicate is
  // genuinely exercised: a unit test with a mocked client proves the where clause was
  // passed, not that the database honours it.
  it.each([
    { label: "the only version is a draft", status: undefined },
    { label: "the version is approved but not published", status: "approved" as const },
    { label: "the published version was retired", status: "retired" as const },
  ])("stores no cover snapshot when $label", async ({ status }) => {
    const fixture = await createFixture();
    if (status) {
      await publishFixtureCover(fixture);
      await firstClient.resourceCoverVersion.update({
        where: { id: fixture.coverVersionId },
        data: { status },
      });
    }

    const created = await firstRepository.createOrLoadAttempt({
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });

    expect(created.kind).toBe("created");
    expect(created.attempt.coverVersionId).toBeNull();
    expect(created.cover).toBeNull();
  });

  it("stores the published cover and its derived immutable DM path", async () => {
    const fixture = await createFixture();
    const dmStoragePath = await publishFixtureCover(fixture);

    const created = await firstRepository.createOrLoadAttempt({
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });

    expect(created.attempt.coverVersionId).toBe(fixture.coverVersionId);
    expect(created.cover).toEqual({
      versionId: fixture.coverVersionId,
      resourceId: fixture.resourceId,
      dmStoragePath,
    });
  });

  // The predicate also filters on render status, content hash and DM path. Those cannot
  // be tested as exclusions, because the schema makes a published row without them
  // unrepresentable — which is a stronger guarantee than the predicate. Proven here so
  // the redundancy is on record rather than assumed.
  it.each([
    {
      label: "an unrendered publish",
      data: { renderStatus: "not_rendered" as const },
      constraint: "resource_cover_version_published_check",
    },
    {
      label: "a publish with no DM path",
      data: { dmStoragePath: null },
      constraint: "resource_cover_version_published_check",
    },
    {
      label: "a publish with no content hash",
      data: { contentHash: null },
      constraint: "resource_cover_version_published_check",
    },
  ])("the database itself refuses $label", async ({ data, constraint }) => {
    const fixture = await createFixture();
    await publishFixtureCover(fixture);

    // Naming the constraint matters: a bare `rejects.toThrow()` would also be satisfied
    // by an unrelated Prisma error and would stop proving the schema is what forbids this.
    await expect(
      firstClient.resourceCoverVersion.update({
        where: { id: fixture.coverVersionId },
        data,
      }),
    ).rejects.toThrow(new RegExp(constraint));
  });

  it("keeps the original snapshot when a newer cover publishes mid-attempt", async () => {
    const fixture = await createFixture();
    const originalPath = await publishFixtureCover(fixture);
    const created = await firstRepository.createOrLoadAttempt({
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });
    expect(created.attempt.coverVersionId).toBe(fixture.coverVersionId);

    // The creator publishes a replacement. Only one row per resource may be published,
    // so the original is retired in the same transaction.
    const newerId = randomUUID();
    const newerHash = "a".repeat(64);
    const original = await firstClient.resourceCoverVersion.findUniqueOrThrow({
      where: { id: fixture.coverVersionId },
    });
    await firstClient.$transaction([
      firstClient.resourceCoverVersion.update({
        where: { id: fixture.coverVersionId },
        data: { status: "retired" },
      }),
      firstClient.resourceCoverVersion.create({
        data: {
          ...original,
          id: newerId,
          revision: original.revision + 1,
          editionNumber: 2,
          status: "published",
          renderStatus: "ready",
          contentHash: newerHash,
          dmStoragePath: `guide-cover/${fixture.resourceId}/${newerId}/${newerHash}/dm.png`,
        },
      }),
    ]);

    const replay = await firstRepository.createOrLoadAttempt({
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });

    expect(replay.kind).toBe("loaded");
    expect(replay.attempt.id).toBe(created.attempt.id);
    // The in-flight attempt still sends what it snapshotted. The original is retired and
    // a newer cover is live, and neither changes this attempt.
    expect(replay.attempt.coverVersionId).toBe(fixture.coverVersionId);
    expect(replay.cover).toEqual({
      versionId: fixture.coverVersionId,
      resourceId: fixture.resourceId,
      dmStoragePath: originalPath,
    });
  });

  it("resolves exactly one cover snapshot across two concurrent creators", async () => {
    const fixture = await createFixture();
    await publishFixtureCover(fixture);
    const input = {
      conversationId: fixture.conversationId,
      resourceId: fixture.resourceId,
      messagingWindowExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    };

    const [left, right] = await Promise.all([
      firstRepository.createOrLoadAttempt(input),
      secondRepository.createOrLoadAttempt(input),
    ]);

    expect(left.attempt.id).toBe(right.attempt.id);
    expect(left.attempt.coverVersionId).toBe(fixture.coverVersionId);
    expect(right.attempt.coverVersionId).toBe(fixture.coverVersionId);
    expect(left.cover).toEqual(right.cover);
    await expect(
      firstClient.guideAccessAttempt.count({ where: { conversationId: fixture.conversationId } }),
    ).resolves.toBe(1);
  });
});
