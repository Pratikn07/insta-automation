import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claimRecovery } from "./dmRecoveryRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// A freshly migrated database holds no rows, and `dm_recovery_reminder` has
// required foreign keys to conversations, ig_users, and keywords. Every
// behavioural assertion below therefore needs its own scaffolding — without it
// an INSERT ... SELECT over an empty source silently affects zero rows and the
// constraint under test is never exercised.

type RecoveryFixture = {
  resourceId: string;
  keywordId: string;
  igUserId: string;
  conversationId: string;
};

let fixture: RecoveryFixture;

async function createRecoveryFixture(client: PrismaClient): Promise<RecoveryFixture> {
  const created: RecoveryFixture = {
    resourceId: randomUUID(),
    keywordId: randomUUID(),
    igUserId: `recovery-contract-user-${randomUUID()}`,
    conversationId: randomUUID(),
  };

  await client.resource.create({
    data: { id: created.resourceId, name: "Task 1 recovery contract resource" },
  });
  await client.keyword.create({
    data: {
      id: created.keywordId,
      keyword: `recovery-contract-${created.keywordId}`,
      resourceId: created.resourceId,
      publicReply: "test",
      gateMessage: "test",
    },
  });
  await client.igUser.create({ data: { id: created.igUserId } });
  await client.conversation.create({
    data: {
      id: created.conversationId,
      igUserId: created.igUserId,
      keywordId: created.keywordId,
    },
  });

  return created;
}

async function deleteRecoveryFixture(
  client: PrismaClient,
  target: RecoveryFixture,
): Promise<void> {
  await client.dmRecoveryReminder.deleteMany({ where: { igUserId: target.igUserId } });
  await client.conversation.deleteMany({ where: { id: target.conversationId } });
  await client.igUser.deleteMany({ where: { id: target.igUserId } });
  await client.keyword.deleteMany({ where: { id: target.keywordId } });
  await client.resource.deleteMany({ where: { id: target.resourceId } });
}

function reminderData(
  overrides: Partial<Prisma.DmRecoveryReminderUncheckedCreateInput> = {},
): Prisma.DmRecoveryReminderUncheckedCreateInput {
  return {
    conversationId: fixture.conversationId,
    igUserId: fixture.igUserId,
    keywordId: fixture.keywordId,
    keywordSnapshot: "PROTEIN",
    templateVersion: "v1",
    publicReplyText: "contract test copy",
    commentId: `recovery-contract-comment-${randomUUID()}`,
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    eligibleAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  // Schema is applied once by globalSetup, before any worker starts. Ten suites each
  // running `migrate deploy` in parallel raced the advisory lock and made a different
  // suite's catalog assertion fail on each run.

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  fixture = await createRecoveryFixture(prisma);
});

afterAll(async () => {
  if (!prisma) return;
  if (fixture) await deleteRecoveryFixture(prisma, fixture);
  await prisma.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────

type TableRow = { table_name: string };
type RlsRow = { relname: string; relrowsecurity: boolean };
type PolicyRow = { policyname: string; tablename: string };
type ColumnRow = { table_name: string; column_name: string; data_type: string };
type IndexRow = { indexname: string; indexdef: string };

describeWithLocalDatabase("dm recovery database contract", () => {
  afterEach(async () => {
    // Reminder rows are per-test; the partial `sending` index is per-user, so a
    // leaked row from one test would mask a real failure in the next.
    await prisma.dmRecoveryReminder.deleteMany({ where: { igUserId: fixture.igUserId } });
  });

  // ── Table existence and RLS ────────────────────────────────────────────

  it("creates the recovery tables with correct snake_case names", async () => {
    const tables = await prisma.$queryRaw<TableRow[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('dm_recovery_reminder', 'dm_recovery_control')
      ORDER BY table_name
    `;
    expect(tables.map((r) => r.table_name)).toEqual([
      "dm_recovery_control",
      "dm_recovery_reminder",
    ]);
  });

  it("enables RLS on both recovery tables", async () => {
    const rls = await prisma.$queryRaw<RlsRow[]>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('dm_recovery_reminder', 'dm_recovery_control')
      ORDER BY relname
    `;
    expect(rls).toEqual([
      { relname: "dm_recovery_control", relrowsecurity: true },
      { relname: "dm_recovery_reminder", relrowsecurity: true },
    ]);
  });

  it("has no permissive anon or authenticated RLS policies", async () => {
    const policies = await prisma.$queryRaw<PolicyRow[]>`
      SELECT policyname, tablename
      FROM pg_policies
      WHERE tablename IN ('dm_recovery_reminder', 'dm_recovery_control')
    `;
    expect(policies).toEqual([]);
  });

  // ── Singleton control ──────────────────────────────────────────────────

  it("seeds the singleton control row with id = 1", async () => {
    const control = await prisma.$queryRaw<Array<{ id: number; circuit_open: boolean }>>`
      SELECT id, circuit_open FROM "dm_recovery_control" WHERE id = 1
    `;
    expect(control).toHaveLength(1);
    expect(control[0]?.circuit_open).toBe(false);
  });

  it("rejects a second control row because id is pinned to 1", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_control" ("id", "circuit_open", "updated_at")
        VALUES (2, false, NOW())
      `,
    ).rejects.toThrow(/dm_recovery_control_id_check/);
  });

  // ── Comment-level idempotency (unique commentId) ───────────────────────

  it("rejects a duplicate commentId with P2002", async () => {
    const commentId = `recovery-contract-dup-${randomUUID()}`;

    await expect(
      prisma.dmRecoveryReminder.create({ data: reminderData({ commentId }) }),
    ).resolves.toMatchObject({ commentId });

    await expect(
      prisma.dmRecoveryReminder.create({ data: reminderData({ commentId }) }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  // ── Partial per-user sending index ─────────────────────────────────────

  it("has a partial unique index on ig_user_id WHERE status = sending", async () => {
    const indexes = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'dm_recovery_reminder'
        AND indexname = 'dm_recovery_reminder_ig_user_sending_key'
    `;
    expect(indexes).toHaveLength(1);
    const indexDef = indexes[0]!.indexdef.toLowerCase();
    expect(indexDef).toContain("unique");
    expect(indexDef).toContain("ig_user_id");
    expect(indexDef).toContain("sending");
  });

  it("prevents two concurrent sending rows for the same ig_user_id with P2002", async () => {
    const claimedAt = new Date();
    const claimExpiresAt = new Date(claimedAt.getTime() + 900_000);

    await expect(
      prisma.dmRecoveryReminder.create({
        data: reminderData({
          status: "sending",
          claimedAt,
          claimExpiresAt,
          claimToken: randomUUID(),
        }),
      }),
    ).resolves.toMatchObject({ status: "sending" });

    await expect(
      prisma.dmRecoveryReminder.create({
        data: reminderData({
          status: "sending",
          claimedAt,
          claimExpiresAt,
          claimToken: randomUUID(),
        }),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("still allows a non-sending row for a user who already has one sending", async () => {
    await prisma.dmRecoveryReminder.create({ data: reminderData({ status: "sending" }) });

    // Proves the index is partial rather than a blanket unique on ig_user_id.
    await expect(
      prisma.dmRecoveryReminder.create({ data: reminderData({ status: "waiting" }) }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  // ── All recovery timestamps use timestamptz ────────────────────────────

  it("stores all recovery timestamps with time zone", async () => {
    const expectedRecoveryTimestamps = [
      "accepted_at",
      "cancelled_at",
      "claim_expires_at",
      "claimed_at",
      "created_at",
      "eligible_at",
      "engaged_at",
      "engaged_received_at",
      "last_attempt_at",
      "next_attempt_at",
      "postback_at",
      "reacted_at",
      "replied_at",
      "replied_received_at",
      "reviewed_at",
      "seen_at",
      "seen_received_at",
      "sent_at",
      "suppressed_at",
      "updated_at",
    ];

    const columns = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dm_recovery_reminder'
        AND data_type = 'timestamp with time zone'
      ORDER BY column_name
    `;

    const columnNames = columns.map((c) => c.column_name);
    for (const expected of expectedRecoveryTimestamps) {
      expect(columnNames, `Missing timestamptz column: ${expected}`).toContain(expected);
    }
    expect(columnNames).toEqual(expectedRecoveryTimestamps);
  });

  it("stores control timestamps with time zone", async () => {
    const columns = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dm_recovery_control'
        AND column_name IN ('opened_at', 'reset_at', 'updated_at')
      ORDER BY column_name
    `;

    expect(columns.map((c) => c.column_name)).toEqual(["opened_at", "reset_at", "updated_at"]);
    for (const col of columns) {
      expect(col.data_type, `${col.column_name} is not timestamptz`).toBe(
        "timestamp with time zone",
      );
    }
  });

  it("stores added DmMessage timestamps with time zone", async () => {
    const columns = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dm_message'
        AND column_name IN ('seen_at', 'deleted_at')
      ORDER BY column_name
    `;

    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.column_name)).toEqual(["deleted_at", "seen_at"]);
    for (const col of columns) {
      expect(col.data_type).toBe("timestamp with time zone");
    }
  });

  it("stores added GateQueue timestamps with time zone and has media_id", async () => {
    const columns = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'gate_queue'
        AND column_name IN ('claimed_at', 'claim_expires_at', 'media_id')
      ORDER BY column_name
    `;

    expect(columns).toHaveLength(3);
    const nameMap = Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]));
    expect(nameMap["claimed_at"]).toBe("timestamp with time zone");
    expect(nameMap["claim_expires_at"]).toBe("timestamp with time zone");
    expect(nameMap["media_id"]).toBe("text");
  });

  // ── Concurrent claim contract ──────────────────────────────────────────
  //
  // The unit tests mock Prisma, so the claim's serialisable transaction and
  // compare-and-set are only ever exercised for real here.

  it("lets exactly one of two concurrent workers claim the same due row", async () => {
    const eligibleAt = new Date(Date.now() - 60_000);
    const row = await prisma.dmRecoveryReminder.create({
      // A claimable row must be correlatable, or the policy correctly
      // withholds it as tracking_unavailable.
      data: reminderData({ eligibleAt, instagramGateMessageId: `mid-${randomUUID()}` }),
    });

    const now = new Date();
    const lease = new Date(now.getTime() + 900_000);
    const results = await Promise.all([
      claimRecovery(row.id, now, lease),
      claimRecovery(row.id, now, lease),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await prisma.dmRecoveryReminder.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("sending");
  });

  it("never lets one person hold two sending claims at once", async () => {
    const older = await prisma.dmRecoveryReminder.create({
      data: reminderData({
        eligibleAt: new Date(Date.now() - 120_000),
        instagramGateMessageId: `mid-${randomUUID()}`,
      }),
    });
    const newer = await prisma.dmRecoveryReminder.create({
      data: reminderData({
        eligibleAt: new Date(Date.now() - 60_000),
        instagramGateMessageId: `mid-${randomUUID()}`,
      }),
    });

    const now = new Date();
    const lease = new Date(now.getTime() + 900_000);
    await Promise.all([
      claimRecovery(older.id, now, lease),
      claimRecovery(newer.id, now, lease),
    ]);

    const sending = await prisma.dmRecoveryReminder.count({
      where: { igUserId: fixture.igUserId, status: "sending" },
    });
    expect(sending).toBeLessThanOrEqual(1);
  });

  // ── Terminal-state consistency constraints ──────────────────────────────
  //
  // These use raw VALUES inserts because the invalid states are unreachable
  // through the typed client's happy path, and they assert the *constraint
  // name* so an unrelated failure (bad FK, wrong enum) cannot be mistaken for
  // the constraint firing.

  it("enforces sent rows must have sent_at", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at", "sent_at"
        )
        VALUES (
          gen_random_uuid(),
          ${fixture.conversationId}::uuid,
          ${fixture.igUserId},
          ${fixture.keywordId}::uuid,
          'TEST', 'v1', 'test',
          ${`chk-sent-${randomUUID()}`},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'sent'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(), NULL
        )
      `,
    ).rejects.toThrow(/chk_sent_has_sent_at/);
  });

  it("enforces cancelled rows must have cancelled_at", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at", "cancelled_at"
        )
        VALUES (
          gen_random_uuid(),
          ${fixture.conversationId}::uuid,
          ${fixture.igUserId},
          ${fixture.keywordId}::uuid,
          'TEST', 'v1', 'test',
          ${`chk-cancel-${randomUUID()}`},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'cancelled'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(), NULL
        )
      `,
    ).rejects.toThrow(/chk_cancelled_has_cancelled_at/);
  });

  it("enforces suppressed rows must have suppressed_at", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at", "suppressed_at"
        )
        VALUES (
          gen_random_uuid(),
          ${fixture.conversationId}::uuid,
          ${fixture.igUserId},
          ${fixture.keywordId}::uuid,
          'TEST', 'v1', 'test',
          ${`chk-suppress-${randomUUID()}`},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'suppressed'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(), NULL
        )
      `,
    ).rejects.toThrow(/chk_suppressed_has_suppressed_at/);
  });

  it("enforces claim_expires_at >= claimed_at", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at",
          "claimed_at", "claim_expires_at"
        )
        VALUES (
          gen_random_uuid(),
          ${fixture.conversationId}::uuid,
          ${fixture.igUserId},
          ${fixture.keywordId}::uuid,
          'TEST', 'v1', 'test',
          ${`chk-claim-${randomUUID()}`},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'sending'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(),
          '2026-08-06T12:00:00Z'::TIMESTAMPTZ,
          '2026-08-06T11:00:00Z'::TIMESTAMPTZ
        )
      `,
    ).rejects.toThrow(/chk_claim_expires_after_claimed/);
  });

  it("enforces attempts must be non-negative", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at", "attempts"
        )
        VALUES (
          gen_random_uuid(),
          ${fixture.conversationId}::uuid,
          ${fixture.igUserId},
          ${fixture.keywordId}::uuid,
          'TEST', 'v1', 'test',
          ${`chk-attempts-${randomUUID()}`},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'waiting'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(), -1
        )
      `,
    ).rejects.toThrow(/dm_recovery_reminder_attempts_check/);
  });
});
