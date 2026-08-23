import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const TABLES = ["guide_access_attempt", "guide_action_token"] as const;

type IndexMetadata = {
  index_name: string;
  is_unique: boolean;
  is_valid: boolean;
  key_columns: string[];
  predicate: string | null;
  table_name: string;
};

let prisma: PrismaClient;

function normalizeCatalogExpression(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/"/g, "")
    .replace(/::[a-z_][a-z0-9_]*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function loadIndexMetadata(): Promise<IndexMetadata[]> {
  return prisma.$queryRaw<IndexMetadata[]>`
    SELECT
      index_row.relname AS index_name,
      index_catalog.indisunique AS is_unique,
      index_catalog.indisvalid AS is_valid,
      ARRAY(
        SELECT COALESCE(
          attribute_row.attname,
          pg_get_indexdef(index_catalog.indexrelid, key_column.ordinal::integer, true)
        )
        FROM unnest(index_catalog.indkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        LEFT JOIN pg_attribute attribute_row
          ON attribute_row.attrelid = index_catalog.indrelid
         AND attribute_row.attnum = key_column.attnum
        WHERE key_column.ordinal <= index_catalog.indnkeyatts
        ORDER BY key_column.ordinal
      ) AS key_columns,
      pg_get_expr(index_catalog.indpred, index_catalog.indrelid) AS predicate,
      table_row.relname AS table_name
    FROM pg_index index_catalog
    JOIN pg_class table_row ON table_row.oid = index_catalog.indrelid
    JOIN pg_class index_row ON index_row.oid = index_catalog.indexrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname IN ('guide_access_attempt', 'guide_action_token')
    ORDER BY table_row.relname, index_row.relname
  `;
}

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(LOOPBACK_HOSTS).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase("guide access attempt migration", () => {
  it("creates server-owned RLS tables with no browser-role grants", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; table_name: string }>
    >`
      SELECT class_row.relrowsecurity, class_row.relname AS table_name
      FROM pg_class class_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND class_row.relname IN ('guide_access_attempt', 'guide_action_token')
      ORDER BY class_row.relname
    `;
    expect(tables).toEqual(
      TABLES.map((table_name) => ({ relrowsecurity: true, table_name })),
    );

    const grants = await prisma.$queryRaw<Array<{ grantee: string; table_name: string }>>`
      SELECT grantee, table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('guide_access_attempt', 'guide_action_token')
        AND grantee IN ('anon', 'authenticated')
      ORDER BY table_name, grantee
    `;
    expect(grants).toEqual([]);
  });

  it("creates the exact lifecycle enums", async () => {
    const values = await prisma.$queryRaw<Array<{ enum_name: string; enum_value: string }>>`
      SELECT type_row.typname AS enum_name, enum_row.enumlabel AS enum_value
      FROM pg_type type_row
      JOIN pg_enum enum_row ON enum_row.enumtypid = type_row.oid
      WHERE type_row.typname IN (
        'guide_access_attempt_state',
        'guide_follow_result',
        'guide_cover_exposure',
        'guide_action_token_action',
        'guide_action_token_status'
      )
      ORDER BY type_row.typname, enum_row.enumsortorder
    `;

    expect(values).toEqual([
      { enum_name: "guide_access_attempt_state", enum_value: "awaiting_request" },
      { enum_name: "guide_access_attempt_state", enum_value: "checking_follow" },
      { enum_name: "guide_access_attempt_state", enum_value: "awaiting_follow" },
      { enum_name: "guide_access_attempt_state", enum_value: "delivering" },
      { enum_name: "guide_access_attempt_state", enum_value: "delivered" },
      { enum_name: "guide_access_attempt_state", enum_value: "needs_review" },
      { enum_name: "guide_access_attempt_state", enum_value: "expired" },
      { enum_name: "guide_action_token_action", enum_value: "request_guide" },
      { enum_name: "guide_action_token_action", enum_value: "check_follow" },
      { enum_name: "guide_action_token_status", enum_value: "active" },
      { enum_name: "guide_action_token_status", enum_value: "consumed" },
      { enum_name: "guide_action_token_status", enum_value: "expired" },
      { enum_name: "guide_action_token_status", enum_value: "cancelled" },
      { enum_name: "guide_cover_exposure", enum_value: "not_shown" },
      { enum_name: "guide_cover_exposure", enum_value: "accepted" },
      { enum_name: "guide_cover_exposure", enum_value: "uncertain" },
      { enum_name: "guide_cover_exposure", enum_value: "failed" },
      { enum_name: "guide_follow_result", enum_value: "follower" },
      { enum_name: "guide_follow_result", enum_value: "non_follower" },
      { enum_name: "guide_follow_result", enum_value: "unknown" },
    ]);
  });

  it("uses UUID identities and TIMESTAMPTZ(3) lifecycle fields", async () => {
    const columns = await prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
        datetime_precision: number | null;
        table_name: string;
        udt_name: string;
      }>
    >`
      SELECT table_name, column_name, data_type, udt_name, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('guide_access_attempt', 'guide_action_token')
      ORDER BY table_name, ordinal_position
    `;

    expect(columns).toEqual([
      { table_name: "guide_access_attempt", column_name: "id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "conversation_id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "resource_id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "cover_version_id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "state", data_type: "USER-DEFINED", udt_name: "guide_access_attempt_state", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "last_follow_result", data_type: "USER-DEFINED", udt_name: "guide_follow_result", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "last_follow_checked_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_access_attempt", column_name: "follow_check_count", data_type: "integer", udt_name: "int4", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "follow_response_count", data_type: "integer", udt_name: "int4", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "cover_exposure", data_type: "USER-DEFINED", udt_name: "guide_cover_exposure", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "cover_provider_message_id", data_type: "text", udt_name: "text", datetime_precision: null },
      { table_name: "guide_access_attempt", column_name: "messaging_window_expires_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_access_attempt", column_name: "created_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_access_attempt", column_name: "updated_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_action_token", column_name: "id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_action_token", column_name: "attempt_id", data_type: "uuid", udt_name: "uuid", datetime_precision: null },
      { table_name: "guide_action_token", column_name: "action", data_type: "USER-DEFINED", udt_name: "guide_action_token_action", datetime_precision: null },
      { table_name: "guide_action_token", column_name: "status", data_type: "USER-DEFINED", udt_name: "guide_action_token_status", datetime_precision: null },
      { table_name: "guide_action_token", column_name: "expires_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_action_token", column_name: "consumed_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
      { table_name: "guide_action_token", column_name: "created_at", data_type: "timestamp with time zone", udt_name: "timestamptz", datetime_precision: 3 },
    ]);
  });

  it("indexes every foreign key and installs the active and expiry access paths", async () => {
    const indexes = await loadIndexMetadata();
    const foreignKeys = await prisma.$queryRaw<
      Array<{ constraint_name: string; source_columns: string[]; source_table: string }>
    >`
      SELECT
        constraint_row.conname AS constraint_name,
        ARRAY(
          SELECT attribute_row.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS source_column(attnum, ordinal)
          JOIN pg_attribute attribute_row
            ON attribute_row.attrelid = constraint_row.conrelid
           AND attribute_row.attnum = source_column.attnum
          ORDER BY source_column.ordinal
        ) AS source_columns,
        source_table.relname AS source_table
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = source_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND namespace_row.nspname = 'public'
        AND source_table.relname IN ('guide_access_attempt', 'guide_action_token')
      ORDER BY constraint_row.conname
    `;

    expect(foreignKeys).toHaveLength(4);
    for (const foreignKey of foreignKeys) {
      expect(
        indexes.some(
          (index) =>
            index.table_name === foreignKey.source_table &&
            index.is_valid &&
            index.predicate === null &&
            foreignKey.source_columns.every(
              (column, position) => index.key_columns[position] === column,
            ),
        ),
        `${foreignKey.constraint_name} lacks a leading full foreign-key index`,
      ).toBe(true);
    }

    const byName = new Map(indexes.map((index) => [index.index_name, index]));
    expect(byName.get("guide_access_attempt_active_conversation_key")).toMatchObject({
      is_unique: true,
      is_valid: true,
      key_columns: ["conversation_id"],
      table_name: "guide_access_attempt",
    });
    expect(
      normalizeCatalogExpression(
        byName.get("guide_access_attempt_active_conversation_key")?.predicate ?? null,
      ),
    ).toBe("(state = any (array['awaiting_request', 'checking_follow', 'awaiting_follow', 'delivering', 'needs_review']))");
    expect(byName.get("guide_access_attempt_expiring_idx")).toMatchObject({
      is_unique: false,
      is_valid: true,
      key_columns: ["messaging_window_expires_at", "id"],
      table_name: "guide_access_attempt",
    });
    expect(
      normalizeCatalogExpression(byName.get("guide_access_attempt_expiring_idx")?.predicate ?? null),
    ).toBe("(state = any (array['awaiting_request', 'checking_follow', 'awaiting_follow', 'delivering', 'needs_review']))");
    expect(byName.get("guide_action_token_attempt_id_status_idx")).toMatchObject({
      is_unique: false,
      is_valid: true,
      key_columns: ["attempt_id", "status"],
      predicate: null,
      table_name: "guide_action_token",
    });
    expect(byName.get("guide_action_token_active_expires_at_idx")).toMatchObject({
      is_unique: false,
      is_valid: true,
      key_columns: ["expires_at", "id"],
      table_name: "guide_action_token",
    });
    expect(
      normalizeCatalogExpression(byName.get("guide_action_token_active_expires_at_idx")?.predicate ?? null),
    ).toBe("(status = 'active')");
  });

  it("restricts attempt snapshots and cascades only tokens", async () => {
    const foreignKeys = await prisma.$queryRaw<
      Array<{
        on_delete: string;
        source_column: string;
        source_table: string;
        target_table: string;
      }>
    >`
      SELECT
        CASE constraint_row.confdeltype
          WHEN 'r' THEN 'RESTRICT'
          WHEN 'c' THEN 'CASCADE'
          ELSE constraint_row.confdeltype::text
        END AS on_delete,
        source_column.attname AS source_column,
        source_table.relname AS source_table,
        target_table.relname AS target_table
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = source_table.relnamespace
      JOIN unnest(constraint_row.conkey) AS source_key(attnum) ON true
      JOIN pg_attribute source_column
        ON source_column.attrelid = source_table.oid
       AND source_column.attnum = source_key.attnum
      WHERE constraint_row.contype = 'f'
        AND namespace_row.nspname = 'public'
        AND source_table.relname IN ('guide_access_attempt', 'guide_action_token')
      ORDER BY source_table.relname, source_column.attname
    `;

    expect(foreignKeys).toEqual([
      { source_table: "guide_access_attempt", source_column: "conversation_id", target_table: "conversations", on_delete: "RESTRICT" },
      { source_table: "guide_access_attempt", source_column: "cover_version_id", target_table: "resource_cover_version", on_delete: "RESTRICT" },
      { source_table: "guide_access_attempt", source_column: "resource_id", target_table: "resources", on_delete: "RESTRICT" },
      { source_table: "guide_action_token", source_column: "attempt_id", target_table: "guide_access_attempt", on_delete: "CASCADE" },
    ]);
  });

  it("enforces bounded counters, exposure evidence, compatible states, and token consumption", async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'public.guide_access_attempt'::regclass,
        'public.guide_action_token'::regclass
      )
        AND contype = 'c'
    `;
    const byName = new Map(
      constraints.map((constraint) => [
        constraint.conname,
        normalizeCatalogExpression(constraint.definition),
      ]),
    );

    expect(byName.get("guide_access_attempt_follow_counts_check")).toMatch(
      /follow_check_count >= 0.*follow_check_count <= 3.*follow_response_count >= 0.*follow_response_count <= 2/,
    );
    expect(byName.get("guide_access_attempt_cover_exposure_check")).toMatch(
      /cover_exposure = 'not_shown'.*cover_provider_message_id is null.*cover_exposure = 'accepted'.*nullif.*cover_provider_message_id.*cover_exposure = 'uncertain'.*cover_exposure = 'failed'.*cover_provider_message_id is null/,
    );
    expect(byName.get("guide_access_attempt_state_follow_result_check")).toMatch(
      /awaiting_request.*checking_follow.*unknown.*awaiting_follow.*non_follower.*delivering.*delivered.*follower.*needs_review.*expired/,
    );
    expect(byName.get("guide_access_attempt_messaging_window_check")).toMatch(
      /messaging_window_expires_at > created_at/,
    );
    expect(byName.get("guide_action_token_expiry_check")).toMatch(/expires_at > created_at/);
    expect(byName.get("guide_action_token_consumption_check")).toMatch(
      /status = 'consumed'.*consumed_at is not null.*status = any.*active.*expired.*cancelled.*consumed_at is null/,
    );
  });
});
