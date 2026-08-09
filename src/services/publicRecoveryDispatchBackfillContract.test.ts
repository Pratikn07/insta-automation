import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const migrationName = "20260809010000_add_public_recovery_dispatch";
const prismaBinary = path.resolve("node_modules/.bin/prisma");

let admin: InstanceType<typeof pg.Client> | undefined;
let fixtureRoot: string | undefined;
const schemas: string[] = [];

function schemaDatabaseUrl(schema: string): string {
  const parsed = new URL(databaseUrl!);
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

async function createSchema(): Promise<string> {
  const schema = `p0_backfill_${randomUUID().replaceAll("-", "")}`;
  if (!/^p0_backfill_[a-f0-9]{32}$/.test(schema)) throw new Error("invalid fixture schema");
  await admin!.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return schema;
}

function prepareMigrationFixture(): string {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "insta-p0-backfill-"));
  const fixturePrisma = path.join(fixtureRoot, "prisma");
  const fixtureMigrations = path.join(fixturePrisma, "migrations");
  mkdirSync(fixtureMigrations, { recursive: true });
  cpSync("prisma/schema.prisma", path.join(fixturePrisma, "schema.prisma"));
  cpSync(
    "prisma/migrations/migration_lock.toml",
    path.join(fixtureMigrations, "migration_lock.toml"),
  );
  for (const entry of readdirSync("prisma/migrations", { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === migrationName) continue;
    cpSync(
      path.join("prisma/migrations", entry.name),
      path.join(fixtureMigrations, entry.name),
      { recursive: true },
    );
  }
  return path.join(fixturePrisma, "schema.prisma");
}

function deploy(schemaFile: string, schema: string): void {
  execFileSync(prismaBinary, ["migrate", "deploy", "--schema", schemaFile], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: schemaDatabaseUrl(schema) },
    stdio: "pipe",
  });
}

async function fixtureClient(schema: string): Promise<InstanceType<typeof pg.Client>> {
  const parsed = new URL(databaseUrl!);
  parsed.searchParams.delete("schema");
  const client = new pg.Client({ connectionString: parsed.toString() });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  return client;
}

const ids = {
  resource: "00000000-0000-4000-8000-000000000001",
  keyword: "00000000-0000-4000-8000-000000000002",
  campaign: "00000000-0000-4000-8000-000000000003",
};

async function seedCommon(client: InstanceType<typeof pg.Client>): Promise<void> {
  await client.query(`
    INSERT INTO resources (id, name) VALUES ('${ids.resource}', 'P0 backfill fixture');
    INSERT INTO keywords (id, keyword, resource_id, public_reply, gate_message, updated_at)
    VALUES ('${ids.keyword}', 'P0FIXTURE', '${ids.resource}', 'reply', 'gate', NOW());
    INSERT INTO recovery_campaign (
      id, phase, state, selection_version, source_data_cutoff, copy_version,
      approved_by, approved_at
    ) VALUES (
      '${ids.campaign}', 'unknown_read_pilot', 'running', 'p0-backfill-v1',
      '2026-07-01T00:00:00Z', 'fixture-v1', 'qa@example.com', '2026-07-01T00:00:00Z'
    );
  `);
}

async function seedConversation(
  client: InstanceType<typeof pg.Client>,
  conversationId: string,
  person: string,
): Promise<void> {
  await client.query(
    "INSERT INTO ig_users (id, updated_at) VALUES ($1, NOW()) ON CONFLICT (id) DO NOTHING",
    [person],
  );
  await client.query(
    `INSERT INTO conversations (id, ig_user_id, keyword_id, state)
     VALUES ($2::uuid, $1, $3::uuid, 'expired');`,
    [person, conversationId, ids.keyword],
  );
}

async function seedIntent(
  client: InstanceType<typeof pg.Client>,
  intentId: string,
  person: string,
  canonicalConversationId: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO journey_intent (
       id, ig_user_id, keyword_id, canonical_conversation_id,
       window_started_at, last_trigger_at, window_expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid,
       '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z'
     )`,
    [intentId, person, ids.keyword, canonicalConversationId],
  );
}

async function seedProductionShapedFixture(client: InstanceType<typeof pg.Client>): Promise<void> {
  await seedCommon(client);

  const prospective = [
    ["10000000-0000-4000-8000-000000000001", "prospective-sent", "sent"],
    ["10000000-0000-4000-8000-000000000002", "prospective-uncertain", "send_uncertain"],
    ["10000000-0000-4000-8000-000000000003", "prospective-retryable", "send_failed"],
    ["10000000-0000-4000-8000-000000000004", "prospective-active", "sending"],
    ["10000000-0000-4000-8000-000000000005", "prospective-cancelled", "cancelled"],
    ["10000000-0000-4000-8000-000000000006", "prospective-alias", "suppressed"],
  ] as const;
  for (const [conversationId, person] of prospective) {
    await seedConversation(client, conversationId, person);
  }

  const canonicalConversationId = "10000000-0000-4000-8000-000000000007";
  const aliasIntentId = "20000000-0000-4000-8000-000000000007";
  await seedConversation(client, canonicalConversationId, "prospective-alias");
  await seedIntent(client, aliasIntentId, "prospective-alias", canonicalConversationId);
  await client.query(
    `UPDATE conversations SET canonical_intent_id = $1::uuid
     WHERE id IN ($2::uuid, $3::uuid)`,
    [aliasIntentId, prospective[5][0], canonicalConversationId],
  );

  await client.query(`
    INSERT INTO dm_recovery_reminder (
      id, conversation_id, ig_user_id, keyword_id, keyword_snapshot,
      template_version, public_reply_text, comment_id, trigger_kind, status,
      cohort, eligible_at, attempts, last_attempt_at, public_reply_id, sent_at,
      last_error_category, claimed_at, claim_expires_at, cancelled_at,
      suppressed_at, suppression_reason
    ) VALUES
      ('30000000-0000-4000-8000-000000000001', '${prospective[0][0]}', 'prospective-sent', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-sent', 'settings_blocked', 'sent', 'treatment', '2026-07-01T00:00:00Z', 1, '2026-07-02T00:00:00Z', 'provider-p-sent', '2026-07-02T00:00:01Z', NULL, NULL, NULL, NULL, NULL, NULL),
      ('30000000-0000-4000-8000-000000000002', '${prospective[1][0]}', 'prospective-uncertain', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-uncertain', 'settings_blocked', 'send_uncertain', 'treatment', '2026-07-01T00:00:00Z', 2, '2026-07-03T00:00:00Z', NULL, NULL, 'timeout', NULL, NULL, NULL, NULL, NULL),
      ('30000000-0000-4000-8000-000000000003', '${prospective[2][0]}', 'prospective-retryable', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-retryable', 'settings_blocked', 'send_failed', 'treatment', '2026-07-01T00:00:00Z', 2, '2026-07-03T00:00:00Z', NULL, NULL, 'rate_limit', NULL, NULL, NULL, NULL, NULL),
      ('30000000-0000-4000-8000-000000000004', '${prospective[3][0]}', 'prospective-active', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-active', 'settings_blocked', 'sending', 'treatment', '2026-07-01T00:00:00Z', 1, '2026-07-04T00:00:00Z', NULL, NULL, NULL, '2026-07-04T00:00:00Z', '2026-07-04T00:15:00Z', NULL, NULL, NULL),
      ('30000000-0000-4000-8000-000000000005', '${prospective[4][0]}', 'prospective-cancelled', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-cancelled', 'settings_blocked', 'cancelled', 'treatment', '2026-07-01T00:00:00Z', 0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-07-05T00:00:00Z', NULL, NULL),
      ('30000000-0000-4000-8000-000000000006', '${prospective[5][0]}', 'prospective-alias', '${ids.keyword}', 'P0', 'v1', 'reply', 'p-alias', 'settings_blocked', 'suppressed', 'treatment', '2026-07-01T00:00:00Z', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-07-05T00:00:00Z', 'reconciled_alias');
  `);

  const historical = [
    ["historical-sent", "40000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000001"],
    ["historical-uncertain", "40000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000002"],
    ["historical-reserved", "40000000-0000-4000-8000-000000000003", "50000000-0000-4000-8000-000000000003"],
    ["historical-started", "40000000-0000-4000-8000-000000000004", "50000000-0000-4000-8000-000000000004"],
    ["historical-retryable", "40000000-0000-4000-8000-000000000005", "50000000-0000-4000-8000-000000000005"],
    ["historical-cancelled", "40000000-0000-4000-8000-000000000006", "50000000-0000-4000-8000-000000000006"],
  ] as const;
  for (const [person, conversationId, intentId] of historical) {
    await seedConversation(client, conversationId, person);
    await seedIntent(client, intentId, person, conversationId);
  }
  await client.query(`
    INSERT INTO recovery_candidate (
      id, campaign_id, campaign_phase, intent_id, ig_user_id, conversation_id,
      keyword_id, comment_id, comment_at, keyword_snapshot, public_reply_text,
      evidence, arm, outcome, eligible_at, attempts, last_attempt_at,
      dispatch_started_at, sent_at, public_reply_id, claimed_at, claim_expires_at,
      claim_token, suppression_reason
    ) VALUES
      ('60000000-0000-4000-8000-000000000001', '${ids.campaign}', 'unknown_read_pilot', '${historical[0][2]}', '${historical[0][0]}', '${historical[0][1]}', '${ids.keyword}', 'h-sent', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'sent', '2026-07-01T00:00:00Z', 1, '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-02T00:00:01Z', 'provider-h-sent', NULL, NULL, NULL, NULL),
      ('60000000-0000-4000-8000-000000000002', '${ids.campaign}', 'unknown_read_pilot', '${historical[1][2]}', '${historical[1][0]}', '${historical[1][1]}', '${ids.keyword}', 'h-uncertain', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'send_uncertain', '2026-07-01T00:00:00Z', 1, '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z', NULL, NULL, NULL, NULL, NULL, 'timeout'),
      ('60000000-0000-4000-8000-000000000003', '${ids.campaign}', 'unknown_read_pilot', '${historical[2][2]}', '${historical[2][0]}', '${historical[2][1]}', '${ids.keyword}', 'h-reserved', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'pending', '2026-07-01T00:00:00Z', 1, '2026-07-04T00:00:00Z', NULL, NULL, NULL, '2026-07-04T00:00:00Z', '2026-07-04T00:15:00Z', '70000000-0000-4000-8000-000000000003', NULL),
      ('60000000-0000-4000-8000-000000000004', '${ids.campaign}', 'unknown_read_pilot', '${historical[3][2]}', '${historical[3][0]}', '${historical[3][1]}', '${ids.keyword}', 'h-started', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'pending', '2026-07-01T00:00:00Z', 1, '2026-07-04T00:00:00Z', '2026-07-04T00:00:01Z', NULL, NULL, '2026-07-04T00:00:00Z', '2026-07-04T00:15:00Z', '70000000-0000-4000-8000-000000000004', NULL),
      ('60000000-0000-4000-8000-000000000005', '${ids.campaign}', 'unknown_read_pilot', '${historical[4][2]}', '${historical[4][0]}', '${historical[4][1]}', '${ids.keyword}', 'h-retryable', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'send_failed', '2026-07-01T00:00:00Z', 2, '2026-07-05T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL, 'rate_limit'),
      ('60000000-0000-4000-8000-000000000006', '${ids.campaign}', 'unknown_read_pilot', '${historical[5][2]}', '${historical[5][0]}', '${historical[5][1]}', '${ids.keyword}', 'h-cancelled', '2026-06-01T00:00:00Z', 'P0', 'reply', 'gate_sent_no_read', 'treatment', 'cancelled', '2026-07-01T00:00:00Z', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'owner_cancelled');
  `);
}

async function seedCollisionFixture(client: InstanceType<typeof pg.Client>): Promise<void> {
  await seedCommon(client);
  const person = "collision-person";
  const prospectiveConversation = "80000000-0000-4000-8000-000000000001";
  const historicalConversation = "80000000-0000-4000-8000-000000000002";
  const intentId = "80000000-0000-4000-8000-000000000003";
  await seedConversation(client, prospectiveConversation, person);
  await client.query(
    `INSERT INTO conversations (id, ig_user_id, keyword_id, state)
     VALUES ($1::uuid, $2, $3::uuid, 'expired')`,
    [historicalConversation, person, ids.keyword],
  );
  await seedIntent(client, intentId, person, historicalConversation);
  await client.query(`
    INSERT INTO dm_recovery_reminder (
      id, conversation_id, ig_user_id, keyword_id, keyword_snapshot,
      template_version, public_reply_text, comment_id, trigger_kind, status,
      cohort, eligible_at, attempts, last_attempt_at, claimed_at, claim_expires_at
    ) VALUES (
      '80000000-0000-4000-8000-000000000004', '${prospectiveConversation}', '${person}',
      '${ids.keyword}', 'P0', 'v1', 'reply', 'collision-p', 'settings_blocked',
      'sending', 'treatment', '2026-07-01T00:00:00Z', 1,
      '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z', '2026-07-04T00:15:00Z'
    );
    INSERT INTO recovery_candidate (
      id, campaign_id, campaign_phase, intent_id, ig_user_id, conversation_id,
      keyword_id, comment_id, comment_at, keyword_snapshot, public_reply_text,
      evidence, arm, outcome, eligible_at, attempts, last_attempt_at,
      claimed_at, claim_expires_at, claim_token
    ) VALUES (
      '80000000-0000-4000-8000-000000000005', '${ids.campaign}',
      'unknown_read_pilot', '${intentId}', '${person}', '${historicalConversation}',
      '${ids.keyword}', 'collision-h', '2026-06-01T00:00:00Z', 'P0', 'reply',
      'gate_sent_no_read', 'treatment', 'pending', '2026-07-01T00:00:00Z', 1,
      '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z', '2026-07-04T00:15:00Z',
      '80000000-0000-4000-8000-000000000006'
    );
  `);
}

afterAll(async () => {
  if (admin) {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin.end();
  }
  if (fixtureRoot?.startsWith(path.join(tmpdir(), "insta-p0-backfill-"))) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describeWithDatabase("public recovery dispatch backfill", () => {
  it("backfills production-shaped states and rejects active-person collisions atomically", async () => {
    const parsed = new URL(databaseUrl!);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
    parsed.searchParams.delete("schema");
    admin = new pg.Client({ connectionString: parsed.toString() });
    await admin.connect();

    const validSchema = await createSchema();
    const collisionSchema = await createSchema();
    const schemaFile = prepareMigrationFixture();
    deploy(schemaFile, validSchema);
    deploy(schemaFile, collisionSchema);

    const valid = await fixtureClient(validSchema);
    const collision = await fixtureClient(collisionSchema);
    try {
      await seedProductionShapedFixture(valid);
      await seedCollisionFixture(collision);

      cpSync(
        path.join("prisma/migrations", migrationName),
        path.join(fixtureRoot!, "prisma", "migrations", migrationName),
        { recursive: true },
      );
      deploy(schemaFile, validSchema);

      const states = await valid.query<{ state: string; count: string }>(`
        SELECT state::text, COUNT(*)::text AS count
        FROM public_recovery_dispatch
        GROUP BY state
        ORDER BY state
      `);
      expect(states.rows).toEqual([
        { state: "dispatch_started", count: "2" },
        { state: "reserved", count: "1" },
        { state: "sent", count: "2" },
        { state: "uncertain", count: "2" },
      ]);
      const excluded = await valid.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM public_recovery_dispatch
        WHERE source_id IN (
          '30000000-0000-4000-8000-000000000003',
          '30000000-0000-4000-8000-000000000005',
          '30000000-0000-4000-8000-000000000006',
          '60000000-0000-4000-8000-000000000005',
          '60000000-0000-4000-8000-000000000006'
        )
      `);
      expect(excluded.rows).toEqual([{ count: "0" }]);
      const prospectiveClaim = await valid.query<{ claim_token: string | null }>(`
        SELECT claim_token::text
        FROM dm_recovery_reminder
        WHERE id = '30000000-0000-4000-8000-000000000004'
      `);
      expect(prospectiveClaim.rows[0]?.claim_token).toMatch(/^[a-f0-9-]{36}$/);

      let collisionError = "";
      try {
        deploy(schemaFile, collisionSchema);
      } catch (error) {
        const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
        collisionError = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}${failure.message ?? ""}`;
      }
      expect(collisionError).toContain(
        "public recovery backfill contains multiple active attempts for one person",
      );

      const rolledBack = await collision.query<{
        ledger: string | null;
        claim_column: string | null;
      }>(`
        SELECT
          to_regclass('${collisionSchema}.public_recovery_dispatch')::text AS ledger,
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = '${collisionSchema}'
              AND table_name = 'dm_recovery_reminder'
              AND column_name = 'claim_token'
          ) AS claim_column
      `);
      expect(rolledBack.rows).toEqual([{ ledger: null, claim_column: null }]);
    } finally {
      await valid.end();
      await collision.end();
    }
  }, 60_000);
});
