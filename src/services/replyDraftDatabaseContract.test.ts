import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  claimApprovedDraft,
  claimRetryDraft,
  DraftActionError,
} from "./replyDraftService.js";
import { CURRENT_DM_PROMPT_VERSION } from "./replyDraftPolicy.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

beforeAll(() => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  // The opt-in contract owns only a caller-provided local disposable database.
  // Applying every checked-in migration here makes the race proof exercise the
  // deployed schema, rather than a schema synthesized from Prisma models.
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
});

type TimestampColumn = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

type FollowUpFixture = {
  threadId: string;
  inboundMessageId: string;
  draftId: string;
  resourceId: string;
  keywordId: string;
  conversationId: string;
};

async function createFollowUpFixture(
  prisma: PrismaClient,
  input: {
    databaseNow: Date;
    expiresAt: Date;
    promptVersion?: number;
  },
): Promise<FollowUpFixture> {
  const fixture = {
    threadId: randomUUID(),
    inboundMessageId: randomUUID(),
    draftId: randomUUID(),
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    conversationId: randomUUID(),
  };

  await prisma.resource.create({
    data: { id: fixture.resourceId, name: "Task 6 atomicity test resource" },
  });
  await prisma.keyword.create({
    data: {
      id: fixture.keywordId,
      keyword: `task6-${fixture.keywordId}`,
      resourceId: fixture.resourceId,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await prisma.conversation.create({
    data: {
      id: fixture.conversationId,
      igUserId: `conversation-user-${fixture.threadId}`,
      keywordId: fixture.keywordId,
      state: "completed",
    },
  });
  await prisma.dmThread.create({
    data: {
      id: fixture.threadId,
      igAccountId: `account-${fixture.threadId}`,
      igUserId: `user-${fixture.threadId}`,
      latestInboundMessageId: fixture.inboundMessageId,
      needsReply: true,
      lastMessageAt: input.databaseNow,
      lastInboundAt: input.databaseNow,
    },
  });
  await prisma.replyDraft.create({
    data: {
      id: fixture.draftId,
      threadId: fixture.threadId,
      inboundMessageId: fixture.inboundMessageId,
      revision: 1,
      status: "pending_approval",
      kind: "engagement_follow_up",
      sourceConversationId: fixture.conversationId,
      promptVersion: input.promptVersion ?? CURRENT_DM_PROMPT_VERSION,
      suggestedText: "Follow-up suggestion",
      workingText: "Original owner follow-up",
      eligibleAt: new Date(input.databaseNow.getTime() - 60_000),
      expiresAt: input.expiresAt,
    },
  });

  return fixture;
}

async function deleteFollowUpFixture(
  prisma: PrismaClient,
  fixture: FollowUpFixture,
): Promise<void> {
  await prisma.dmThread.deleteMany({ where: { id: fixture.threadId } });
  await prisma.conversation.deleteMany({ where: { id: fixture.conversationId } });
  await prisma.keyword.deleteMany({ where: { id: fixture.keywordId } });
  await prisma.resource.deleteMany({ where: { id: fixture.resourceId } });
}

async function waitForBlockedClaim(prisma: PrismaClient, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "reply_draft"%'
          AND query LIKE '%FOR UPDATE%'
      ) AS blocked
    `;
    if (rows[0]?.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describeWithLocalDatabase("owner-approved follow-up database contract", () => {
  it("stores scheduling and deadline instants with time zones in migrations and the Prisma schema", async () => {
    const parsedUrl = new URL(databaseUrl!);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);

    const declaredSchema = "task2_timezone_schema_contract";
    const declaredSchemaUrl = new URL(databaseUrl!);
    declaredSchemaUrl.searchParams.set("schema", declaredSchema);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${declaredSchema}" CASCADE`);
      execFileSync(
        path.resolve("node_modules/.bin/prisma"),
        ["db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: declaredSchemaUrl.toString() },
          stdio: "pipe",
        },
      );

      const columns = await prisma.$queryRawUnsafe<TimestampColumn[]>(`
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema IN ('public', '${declaredSchema}')
          AND (table_name, column_name) IN (
            ('conversations', 'engagement_follow_up_scheduled_at'),
            ('reply_draft', 'eligible_at'),
            ('reply_draft', 'expires_at')
          )
        ORDER BY table_schema, table_name, column_name
      `);

      expect(columns).toEqual([
        {
          table_schema: "public",
          table_name: "conversations",
          column_name: "engagement_follow_up_scheduled_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: "public",
          table_name: "reply_draft",
          column_name: "eligible_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: "public",
          table_name: "reply_draft",
          column_name: "expires_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "conversations",
          column_name: "engagement_follow_up_scheduled_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "reply_draft",
          column_name: "eligible_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "reply_draft",
          column_name: "expires_at",
          data_type: "timestamp with time zone",
        },
      ]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${declaredSchema}" CASCADE`);
      await prisma.$disconnect();
    }
  });

  it("allows exactly one real concurrent owner approval and persists the exact approved text", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const threadId = randomUUID();
    const inboundMessageId = randomUUID();
    const draftId = randomUUID();
    const approvedText = "Owner-approved exact text — line one\nline two 💛";

    try {
      await prisma.dmThread.create({
        data: {
          id: threadId,
          igAccountId: `account-${threadId}`,
          igUserId: `user-${threadId}`,
          latestInboundMessageId: inboundMessageId,
          needsReply: true,
          lastMessageAt: new Date(),
          lastInboundAt: new Date(),
        },
      });
      await prisma.replyDraft.create({
        data: {
          id: draftId,
          threadId,
          inboundMessageId,
          revision: 1,
          status: "pending_approval",
          kind: "reply",
          promptVersion: CURRENT_DM_PROMPT_VERSION,
          suggestedText: "Model text that must never be sent",
          workingText: "Stale editor copy",
        },
      });

      const input = {
        threadId,
        draftId,
        approvedBy: "owner@example.com",
        workingText: approvedText,
      };
      const outcomes = await Promise.allSettled([
        claimApprovedDraft(input),
        claimApprovedDraft(input),
      ]);

      const winners = outcomes.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimApprovedDraft>>> =>
          result.status === "fulfilled",
      );
      const losers = outcomes.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(winners).toHaveLength(1);
      expect(winners[0]?.value).toEqual({ approvedText, inboundMessageId });
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toBeInstanceOf(DraftActionError);
      expect(losers[0]?.reason).toMatchObject({ code: "draft_not_pending" });

      await expect(prisma.replyDraft.findUniqueOrThrow({ where: { id: draftId } })).resolves.toMatchObject({
        status: "sending",
        suggestedText: "Model text that must never be sent",
        workingText: approvedText,
        approvedText,
        approvedBy: "owner@example.com",
        inboundMessageId,
      });
    } finally {
      await prisma.dmThread.deleteMany({ where: { id: threadId } });
      await prisma.$disconnect();
    }
  });

  it("allows exactly one real concurrent retry claim without changing the approved text", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const threadId = randomUUID();
    const inboundMessageId = randomUUID();
    const draftId = randomUUID();
    const approvedText = "Previously approved exact text 🔒";

    try {
      await prisma.dmThread.create({
        data: {
          id: threadId,
          igAccountId: `account-${threadId}`,
          igUserId: `user-${threadId}`,
          latestInboundMessageId: inboundMessageId,
          needsReply: true,
          lastMessageAt: new Date(),
          lastInboundAt: new Date(),
        },
      });
      await prisma.replyDraft.create({
        data: {
          id: draftId,
          threadId,
          inboundMessageId,
          revision: 1,
          status: "send_uncertain",
          kind: "reply",
          promptVersion: CURRENT_DM_PROMPT_VERSION,
          suggestedText: "Different model text",
          workingText: approvedText,
          approvedText,
          approvedBy: "owner@example.com",
          errorCode: "transport_timeout",
        },
      });

      const input = { threadId, draftId, confirmedNotDelivered: true as const };
      const outcomes = await Promise.allSettled([
        claimRetryDraft(input),
        claimRetryDraft(input),
      ]);

      const winners = outcomes.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimRetryDraft>>> =>
          result.status === "fulfilled",
      );
      const losers = outcomes.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(winners).toHaveLength(1);
      expect(winners[0]?.value).toEqual({ approvedText, inboundMessageId });
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toBeInstanceOf(DraftActionError);
      expect(losers[0]?.reason).toMatchObject({ code: "draft_not_retryable" });

      await expect(prisma.replyDraft.findUniqueOrThrow({ where: { id: draftId } })).resolves.toMatchObject({
        status: "sending",
        suggestedText: "Different model text",
        workingText: approvedText,
        approvedText,
        errorCode: null,
        inboundMessageId,
      });
    } finally {
      await prisma.dmThread.deleteMany({ where: { id: threadId } });
      await prisma.$disconnect();
    }
  });

  it(
    "uses the database clock after lock contention to reject and expire a follow-up",
    async () => {
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
      const lockClient = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
      const threadId = randomUUID();
      const inboundMessageId = randomUUID();
      const draftId = randomUUID();
      const resourceId = randomUUID();
      const keywordId = randomUUID();
      const conversationId = randomUUID();
      let signalLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });

      try {
        const databaseNow = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        const expiresAt = new Date(databaseNow[0]!.now.getTime() + 1_000);
        await prisma.resource.create({ data: { id: resourceId, name: "Task 6 test resource" } });
        await prisma.keyword.create({
          data: {
            id: keywordId,
            keyword: `task6-${keywordId}`,
            resourceId,
            publicReply: "test",
            gateMessage: "test",
          },
        });
        await prisma.conversation.create({
          data: {
            id: conversationId,
            igUserId: `conversation-user-${threadId}`,
            keywordId,
            state: "completed",
          },
        });
        await prisma.dmThread.create({
          data: {
            id: threadId,
            igAccountId: `account-${threadId}`,
            igUserId: `user-${threadId}`,
            latestInboundMessageId: inboundMessageId,
            needsReply: true,
            lastMessageAt: databaseNow[0]!.now,
            lastInboundAt: databaseNow[0]!.now,
          },
        });
        await prisma.replyDraft.create({
          data: {
            id: draftId,
            threadId,
            inboundMessageId,
            revision: 1,
            status: "pending_approval",
            kind: "engagement_follow_up",
            sourceConversationId: conversationId,
            promptVersion: CURRENT_DM_PROMPT_VERSION,
            suggestedText: "Follow-up suggestion",
            workingText: "Owner follow-up",
            eligibleAt: new Date(databaseNow[0]!.now.getTime() - 60_000),
            expiresAt,
          },
        });

        const lockTransaction = lockClient.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe(
              `SELECT "id" FROM "reply_draft" WHERE "id" = $1::uuid FOR UPDATE`,
              draftId,
            );
            signalLockAcquired();
            await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(2)`;
          },
          { timeout: 10_000 },
        );
        await lockAcquired;

        // This application timestamp passes the pre-check. The guarded UPDATE
        // blocks on the row lock, then PostgreSQL's clock crosses expiresAt.
        const outcome = claimApprovedDraft(
          {
            threadId,
            draftId,
            approvedBy: "owner@example.com",
            workingText: "Owner follow-up",
          },
          new Date(),
        ).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );

        await lockTransaction;
        const result = await outcome;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("follow-up claim unexpectedly won");
        expect(result.reason).toBeInstanceOf(DraftActionError);
        expect(result.reason).toMatchObject({ code: "follow_up_window_closed" });

        await expect(prisma.replyDraft.findUniqueOrThrow({ where: { id: draftId } })).resolves.toMatchObject({
          status: "expired",
          workingText: "Owner follow-up",
          approvedText: null,
          errorCode: "follow_up_window_closed",
        });
      } finally {
        await prisma.dmThread.deleteMany({ where: { id: threadId } });
        await prisma.conversation.deleteMany({ where: { id: conversationId } });
        await prisma.keyword.deleteMany({ where: { id: keywordId } });
        await prisma.resource.deleteMany({ where: { id: resourceId } });
        await Promise.all([prisma.$disconnect(), lockClient.$disconnect()]);
      }
    },
    15_000,
  );

  it("rejects an already-expired follow-up and commits its terminal expired state", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const databaseNow = (
      await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    )[0]!.now;
    const fixture = await createFollowUpFixture(prisma, {
      databaseNow,
      expiresAt: new Date(databaseNow.getTime() - 1_000),
    });

    try {
      await expect(
        claimApprovedDraft(
          {
            threadId: fixture.threadId,
            draftId: fixture.draftId,
            approvedBy: "owner@example.com",
            workingText: "Text that must not be approved after expiry",
          },
          databaseNow,
        ),
      ).rejects.toMatchObject({ code: "follow_up_window_closed" });

      await expect(
        prisma.replyDraft.findUniqueOrThrow({ where: { id: fixture.draftId } }),
      ).resolves.toMatchObject({
        status: "expired",
        workingText: "Original owner follow-up",
        approvedText: null,
        errorCode: "follow_up_window_closed",
      });
    } finally {
      await deleteFollowUpFixture(prisma, fixture);
      await prisma.$disconnect();
    }
  });

  it(
    "rejects a prompt policy changed while the production claim waits on a real row lock",
    async () => {
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
      const mutationClient = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
      const databaseNow = (
        await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      )[0]!.now;
      const fixture = await createFollowUpFixture(prisma, {
        databaseNow,
        expiresAt: new Date(databaseNow.getTime() + 60_000),
      });
      let signalLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });
      let releasePolicyMutation!: () => void;
      const mayMutatePolicy = new Promise<void>((resolve) => {
        releasePolicyMutation = resolve;
      });
      const mutationTransaction = mutationClient.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "reply_draft" WHERE "id" = $1::uuid FOR UPDATE`,
            fixture.draftId,
          );
          signalLockAcquired();
          await mayMutatePolicy;
          await tx.replyDraft.update({
            where: { id: fixture.draftId },
            data: { promptVersion: CURRENT_DM_PROMPT_VERSION - 1 },
          });
        },
        { timeout: 10_000 },
      );

      try {
        await lockAcquired;
        const outcome = claimApprovedDraft(
          {
            threadId: fixture.threadId,
            draftId: fixture.draftId,
            approvedBy: "owner@example.com",
            workingText: "Policy-stale text that must never be approved",
          },
          databaseNow,
        ).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );

        const observedRealLockWait = await waitForBlockedClaim(prisma);
        releasePolicyMutation();
        expect(observedRealLockWait).toBe(true);
        await mutationTransaction;

        const result = await outcome;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("policy-stale claim unexpectedly won");
        expect(result.reason).toBeInstanceOf(DraftActionError);
        expect(result.reason).toMatchObject({ code: "prompt_policy_outdated" });

        await expect(
          prisma.replyDraft.findUniqueOrThrow({ where: { id: fixture.draftId } }),
        ).resolves.toMatchObject({
          status: "pending_approval",
          promptVersion: CURRENT_DM_PROMPT_VERSION - 1,
          workingText: "Original owner follow-up",
          approvedText: null,
        });
      } finally {
        releasePolicyMutation();
        await mutationTransaction.catch(() => undefined);
        await deleteFollowUpFixture(prisma, fixture);
        await Promise.all([prisma.$disconnect(), mutationClient.$disconnect()]);
      }
    },
    15_000,
  );
});
