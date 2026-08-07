import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;

  const parsedUrl = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────

type TableRow = { table_name: string };
type RlsRow = { relname: string; relrowsecurity: boolean };
type PolicyRow = { policyname: string; tablename: string };
type ColumnRow = { table_name: string; column_name: string; data_type: string };
type IndexRow = { indexname: string; indexdef: string };

// ── Table existence and RLS ──────────────────────────────────────────────

describeWithLocalDatabase("dm recovery database contract", () => {
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

  // ── Comment-level idempotency (unique commentId) ───────────────────────

  it("rejects a duplicate commentId with P2002", async () => {
    // Insert a recovery row via raw SQL to avoid needing full FK scaffolding.
    // We use a self-contained pair with matching foreign keys if the schema
    // requires them. For simplicity, use Prisma's upsert pattern on the unique.
    const commentId = `contract-test-dup-${Date.now()}`;
    const igUserId = `contract-test-ig-${Date.now()}`;

    // First insert succeeds.
    await prisma.$executeRaw`
      INSERT INTO "dm_recovery_reminder" (
        "id", "conversation_id", "ig_user_id", "keyword_id",
        "keyword_snapshot", "template_version", "public_reply_text",
        "comment_id", "trigger_kind", "status", "cohort",
        "eligible_at", "created_at", "updated_at"
      )
      SELECT
        gen_random_uuid(),
        c.id,
        iu.id,
        k.id,
        'TEST', 'v1', 'test text',
        ${commentId},
        'no_confirmed_read'::"dm_recovery_trigger_kind",
        'waiting'::"dm_recovery_status",
        'treatment'::"dm_recovery_cohort",
        NOW(), NOW(), NOW()
      FROM (SELECT id FROM "conversations" LIMIT 1) c,
           (SELECT id FROM "ig_users" LIMIT 1) iu,
           (SELECT id FROM "keywords" LIMIT 1) k
    `;

    // Second insert with the same commentId must fail.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at"
        )
        SELECT
          gen_random_uuid(),
          c.id,
          iu.id,
          k.id,
          'TEST', 'v1', 'test text',
          ${commentId},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'waiting'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW()
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
      `,
    ).rejects.toThrow(/unique/i);

    // Clean up.
    await prisma.$executeRaw`
      DELETE FROM "dm_recovery_reminder" WHERE "comment_id" = ${commentId}
    `;
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

  // ── Terminal-state consistency constraints ──────────────────────────────

  it("enforces sent rows must have sent_at", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at",
          "sent_at"
        )
        SELECT
          gen_random_uuid(), c.id, iu.id, k.id,
          'TEST', 'v1', 'test',
          ${"chk-sent-" + Date.now()},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'sent'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(),
          NULL
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
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
          "eligible_at", "created_at", "updated_at",
          "cancelled_at"
        )
        SELECT
          gen_random_uuid(), c.id, iu.id, k.id,
          'TEST', 'v1', 'test',
          ${"chk-cancel-" + Date.now()},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'cancelled'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(),
          NULL
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
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
          "eligible_at", "created_at", "updated_at",
          "suppressed_at"
        )
        SELECT
          gen_random_uuid(), c.id, iu.id, k.id,
          'TEST', 'v1', 'test',
          ${"chk-suppress-" + Date.now()},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'suppressed'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(),
          NULL
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
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
        SELECT
          gen_random_uuid(), c.id, iu.id, k.id,
          'TEST', 'v1', 'test',
          ${"chk-claim-" + Date.now()},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'sending'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW(),
          '2026-08-06T12:00:00Z'::TIMESTAMPTZ,
          '2026-08-06T11:00:00Z'::TIMESTAMPTZ
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
      `,
    ).rejects.toThrow(/chk_claim_expires_after_claimed/);
  });

  // ── Partial sending index enforcement ──────────────────────────────

  it("prevents two sending rows for the same ig_user_id via partial unique index", async () => {
    const userSendingComment1 = `chk-sending-1-${Date.now()}`;
    const userSendingComment2 = `chk-sending-2-${Date.now()}`;

    // First sending row for user succeeds
    await prisma.$executeRaw`
      INSERT INTO "dm_recovery_reminder" (
        "id", "conversation_id", "ig_user_id", "keyword_id",
        "keyword_snapshot", "template_version", "public_reply_text",
        "comment_id", "trigger_kind", "status", "cohort",
        "eligible_at", "created_at", "updated_at"
      )
      SELECT
        gen_random_uuid(), c.id, iu.id, k.id,
        'TEST', 'v1', 'test',
        ${userSendingComment1},
        'no_confirmed_read'::"dm_recovery_trigger_kind",
        'sending'::"dm_recovery_status",
        'treatment'::"dm_recovery_cohort",
        NOW(), NOW(), NOW()
      FROM (SELECT id FROM "conversations" LIMIT 1) c,
           (SELECT id FROM "ig_users" LIMIT 1) iu,
           (SELECT id FROM "keywords" LIMIT 1) k
    `;

    // Second sending row for same user fails with unique index violation
    await expect(
      prisma.$executeRaw`
        INSERT INTO "dm_recovery_reminder" (
          "id", "conversation_id", "ig_user_id", "keyword_id",
          "keyword_snapshot", "template_version", "public_reply_text",
          "comment_id", "trigger_kind", "status", "cohort",
          "eligible_at", "created_at", "updated_at"
        )
        SELECT
          gen_random_uuid(), c.id, iu.id, k.id,
          'TEST', 'v1', 'test',
          ${userSendingComment2},
          'no_confirmed_read'::"dm_recovery_trigger_kind",
          'sending'::"dm_recovery_status",
          'treatment'::"dm_recovery_cohort",
          NOW(), NOW(), NOW()
        FROM (SELECT id FROM "conversations" LIMIT 1) c,
             (SELECT id FROM "ig_users" LIMIT 1) iu,
             (SELECT id FROM "keywords" LIMIT 1) k
      `,
    ).rejects.toThrow(/unique/i);

    // Clean up
    await prisma.$executeRaw`
      DELETE FROM "dm_recovery_reminder" WHERE "comment_id" = ${userSendingComment1}
    `;
  });
});
