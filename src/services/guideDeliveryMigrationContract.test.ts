import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let prisma: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase("guide delivery ledger migration", () => {
  it("creates backend-only delivery tables", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; table_name: string }>
    >`
      SELECT c.relrowsecurity, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('guide_delivery', 'guide_delivery_unit')
      ORDER BY c.relname
    `;
    expect(tables).toEqual([
      { relrowsecurity: true, table_name: "guide_delivery" },
      { relrowsecurity: true, table_name: "guide_delivery_unit" },
    ]);

    const grants = await prisma.$queryRaw<Array<{ grantee: string; table_name: string }>>`
      SELECT grantee, table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('guide_delivery', 'guide_delivery_unit')
        AND grantee IN ('anon', 'authenticated')
    `;
    expect(grants).toEqual([]);
  });

  it("indexes every foreign key and enforces stable identities", async () => {
    const foreignKeys = await prisma.$queryRaw<
      Array<{ column_name: string; indexed: boolean; table_name: string }>
    >`
      SELECT
        a.attname AS column_name,
        EXISTS (
          SELECT 1
          FROM pg_index i
          WHERE i.indrelid = constraint_row.conrelid
            AND a.attnum = ANY(i.indkey)
        ) AS indexed,
        table_row.relname AS table_name
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace n ON n.oid = table_row.relnamespace
      CROSS JOIN LATERAL unnest(constraint_row.conkey) AS key_column(attnum)
      JOIN pg_attribute a
        ON a.attrelid = constraint_row.conrelid
       AND a.attnum = key_column.attnum
      WHERE constraint_row.contype = 'f'
        AND n.nspname = 'public'
        AND table_row.relname IN ('guide_delivery', 'guide_delivery_unit')
      ORDER BY table_row.relname, a.attname
    `;
    expect(foreignKeys).toEqual([
      { column_name: "conversation_id", indexed: true, table_name: "guide_delivery" },
      { column_name: "resource_id", indexed: true, table_name: "guide_delivery" },
      { column_name: "thread_id", indexed: true, table_name: "guide_delivery" },
      { column_name: "delivery_id", indexed: true, table_name: "guide_delivery_unit" },
      {
        column_name: "resource_message_id",
        indexed: true,
        table_name: "guide_delivery_unit",
      },
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexdef: string; indexname: string }>>`
      SELECT indexdef, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('guide_delivery', 'guide_delivery_unit')
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get("guide_delivery_trigger_kind_trigger_id_key")).toMatch(
      /UNIQUE.*trigger_kind.*trigger_id/i,
    );
    expect(byName.get("guide_delivery_unit_delivery_id_position_key")).toMatch(
      /UNIQUE.*delivery_id.*position/i,
    );
  });

  it("installs worker indexes with predicates matching queue and review queries", async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string; indexname: string }>>`
      SELECT indexdef, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'guide_delivery'
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

    expect(byName.get("guide_delivery_due_idx")).toMatch(
      /next_attempt_at.*created_at.*id.*WHERE.*status.*planned.*failed.*claim_token.*IS NULL/i,
    );
    expect(byName.get("guide_delivery_expired_claim_idx")).toMatch(
      /claim_expires_at.*id.*WHERE.*claim_token.*IS NOT NULL/i,
    );
    expect(byName.get("guide_delivery_thread_review_idx")).toMatch(
      /thread_id.*created_at DESC.*WHERE.*status.*needs_review/i,
    );
  });

  it("installs claim, payload, attempt, and state timestamp checks", async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'public.guide_delivery'::regclass,
        'public.guide_delivery_unit'::regclass
      )
    `;
    const byName = new Map(constraints.map((row) => [row.conname, row.definition]));

    expect(byName.get("guide_delivery_claim_complete_check")).toMatch(
      /claim_token.*claimed_at.*claim_expires_at.*claim_expires_at.*claimed_at/i,
    );
    expect(byName.has("guide_delivery_terminal_timestamps_check")).toBe(true);
    expect(byName.get("guide_delivery_unit_payload_shape_check")).toMatch(
      /kind.*text.*text_snapshot.*media_url_snapshot.*image.*file/i,
    );
    expect(byName.get("guide_delivery_unit_attempts_check")).toMatch(/attempts.*>=.*0/i);
    expect(byName.has("guide_delivery_unit_state_timestamps_check")).toBe(true);
    expect(byName.get("guide_delivery_unit_sent_state_check")).toMatch(
      /sent.*provider_message_id.*owner_confirmed_at/i,
    );
  });

  it("uses immutable text/media snapshots and millisecond owner timestamps", async () => {
    const columns = await prisma.$queryRaw<
      Array<{
        character_maximum_length: number | null;
        column_name: string;
        data_type: string;
        datetime_precision: number | null;
      }>
    >`
      SELECT column_name, data_type, character_maximum_length, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'guide_delivery_unit'
        AND column_name IN (
          'text_snapshot',
          'media_url_snapshot',
          'content_fingerprint',
          'owner_confirmed_at',
          'owner_retry_authorized_at',
          'owner_retry_consumed_at'
        )
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      {
        character_maximum_length: 64,
        column_name: "content_fingerprint",
        data_type: "character",
        datetime_precision: null,
      },
      {
        character_maximum_length: null,
        column_name: "media_url_snapshot",
        data_type: "text",
        datetime_precision: null,
      },
      {
        character_maximum_length: null,
        column_name: "owner_confirmed_at",
        data_type: "timestamp with time zone",
        datetime_precision: 3,
      },
      {
        character_maximum_length: null,
        column_name: "owner_retry_authorized_at",
        data_type: "timestamp with time zone",
        datetime_precision: 3,
      },
      {
        character_maximum_length: null,
        column_name: "owner_retry_consumed_at",
        data_type: "timestamp with time zone",
        datetime_precision: 3,
      },
      {
        character_maximum_length: null,
        column_name: "text_snapshot",
        data_type: "text",
        datetime_precision: null,
      },
    ]);
  });
});
