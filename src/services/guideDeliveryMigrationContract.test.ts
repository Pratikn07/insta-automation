import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const WORKER_INDEX_NAMES = [
  "guide_delivery_due_idx",
  "guide_delivery_expired_claim_idx",
  "guide_delivery_thread_review_idx",
] as const;
const EXPECTED_DUE_INDEX_PREDICATE =
  "((claim_token is null) and ((status = 'planned') or ((status = 'failed') and (next_attempt_at is not null))))";
const PROTECTED_WORKER_INDEX_SHAPES = [
  {
    keyColumns: ["next_attempt_at", "created_at", "id"],
    keyOrders: ["ASC", "ASC", "ASC"],
  },
  {
    keyColumns: ["claim_expires_at", "id"],
    keyOrders: ["ASC", "ASC"],
  },
  {
    keyColumns: ["thread_id", "created_at"],
    keyOrders: ["ASC", "DESC"],
  },
] as const;

type IndexMetadata = {
  included_columns: string[];
  index_name: string;
  is_unique: boolean;
  is_valid: boolean;
  key_columns: string[];
  key_orders: string[];
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

function matchesExpectedDueIndexPredicate(value: string | null): boolean {
  return normalizeCatalogExpression(value) === EXPECTED_DUE_INDEX_PREDICATE;
}

function hasProtectedWorkerKeyShape(keyColumns: string[], keyOrders: string[]): boolean {
  return PROTECTED_WORKER_INDEX_SHAPES.some(
    (shape) =>
      shape.keyColumns.every((column, position) => keyColumns[position] === column) &&
      shape.keyOrders.every((order, position) => keyOrders[position] === order),
  );
}

function findProtectedWorkerIndexDrift(diff: string): string[] {
  const drift = new Set<string>();

  for (const indexName of WORKER_INDEX_NAMES) {
    const escapedName = indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const statement = new RegExp(
      String.raw`\b(?:create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?|drop\s+index\s+(?:if\s+exists\s+)?)(?:"${escapedName}"|${escapedName})(?=\s|\(|;|$)`,
      "i",
    );
    if (statement.test(diff)) drift.add(indexName);
  }

  for (const sqlStatement of diff.split(";")) {
    const create = sqlStatement.match(
      /\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+on\s+(?:(?:"public"|public)\s*\.\s*)?(?:"guide_delivery"|guide_delivery)(?:\s+using\s+[a-z_][a-z0-9_]*)?\s*\(([^)]*)\)([\s\S]*)$/i,
    );
    if (!create) continue;

    const [, quotedName, plainName, rawKeys, suffix] = create;
    if (/\bwhere\b/i.test(suffix)) continue;

    const keyColumns: string[] = [];
    const keyOrders: string[] = [];
    for (const rawKey of rawKeys.split(",")) {
      const key = rawKey.trim().match(/^"?([a-z_][a-z0-9_]*)"?(?:\s+(asc|desc))?/i);
      if (!key) break;
      keyColumns.push(key[1].toLowerCase());
      keyOrders.push((key[2] ?? "ASC").toUpperCase());
    }

    if (hasProtectedWorkerKeyShape(keyColumns, keyOrders)) {
      drift.add(quotedName ?? plainName);
    }
  }

  return [...drift];
}

function findFullWorkerIndexLookalikes(indexes: IndexMetadata[]): string[] {
  return indexes
    .filter(
      (index) =>
        index.table_name === "guide_delivery" &&
        index.predicate === null &&
        hasProtectedWorkerKeyShape(index.key_columns, index.key_orders),
    )
    .map((index) => index.index_name);
}

async function loadIndexMetadata(): Promise<IndexMetadata[]> {
  return prisma.$queryRaw<IndexMetadata[]>`
    SELECT
      ARRAY(
        SELECT COALESCE(
          a.attname,
          pg_get_indexdef(index_catalog.indexrelid, included_column.ordinal::integer, true)
        )
        FROM unnest(index_catalog.indkey) WITH ORDINALITY AS included_column(attnum, ordinal)
        LEFT JOIN pg_attribute a
          ON a.attrelid = index_catalog.indrelid
         AND a.attnum = included_column.attnum
        WHERE included_column.ordinal > index_catalog.indnkeyatts
        ORDER BY included_column.ordinal
      ) AS included_columns,
      index_row.relname AS index_name,
      index_catalog.indisunique AS is_unique,
      index_catalog.indisvalid AS is_valid,
      ARRAY(
        SELECT COALESCE(
          a.attname,
          pg_get_indexdef(index_catalog.indexrelid, key_column.ordinal::integer, true)
        )
        FROM unnest(index_catalog.indkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        LEFT JOIN pg_attribute a
          ON a.attrelid = index_catalog.indrelid
         AND a.attnum = key_column.attnum
        WHERE key_column.ordinal <= index_catalog.indnkeyatts
        ORDER BY key_column.ordinal
      ) AS key_columns,
      ARRAY(
        SELECT CASE
          WHEN (index_catalog.indoption[position - 1] & 1) = 1 THEN 'DESC'
          ELSE 'ASC'
        END
        FROM generate_series(1, index_catalog.indnkeyatts) AS position
      ) AS key_orders,
      pg_get_expr(index_catalog.indpred, index_catalog.indrelid) AS predicate,
      table_row.relname AS table_name
    FROM pg_index index_catalog
    JOIN pg_class table_row ON table_row.oid = index_catalog.indrelid
    JOIN pg_class index_row ON index_row.oid = index_catalog.indexrelid
    JOIN pg_namespace n ON n.oid = table_row.relnamespace
    WHERE n.nspname = 'public'
      AND table_row.relname IN ('guide_delivery', 'guide_delivery_unit')
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

describe("guide delivery Prisma drift guard", () => {
  it.each([
    ["ordinary create", 'CREATE\n INDEX "guide_delivery_due_idx" ON "guide_delivery" ("id");'],
    [
      "unique create",
      'CREATE UNIQUE\n INDEX "guide_delivery_expired_claim_idx" ON "guide_delivery" ("id");',
    ],
    ["drop", 'DROP\n INDEX "guide_delivery_thread_review_idx";'],
    [
      "renamed full lookalike",
      'CREATE INDEX "renamed_due_lookup" ON "guide_delivery" ("next_attempt_at", "created_at", "id");',
    ],
  ])("detects a protected %s statement", (_label, sql) => {
    expect(findProtectedWorkerIndexDrift(sql)).toHaveLength(1);
  });

  it("permits a renamed partial index with a protected queue key shape", () => {
    const sql = `
      CREATE INDEX "renamed_due_lookup"
        ON "guide_delivery" ("next_attempt_at", "created_at", "id")
        WHERE "claim_token" IS NULL;
    `;

    expect(findProtectedWorkerIndexDrift(sql)).toEqual([]);
  });
});

describe("guide delivery due-index predicate guard", () => {
  const exact = `
      (("claim_token" IS NULL)
        AND (("status" = 'planned'::guide_delivery_status)
          OR (("status" = 'failed'::guide_delivery_status)
            AND ("next_attempt_at" IS NOT NULL))))
  `;

  it("accepts the exact normalized worker predicate", () => {
    expect(matchesExpectedDueIndexPredicate(exact)).toBe(true);
  });

  it.each([
    ["an extra clause", `(${exact} AND "created_at" <= CURRENT_TIMESTAMP)`],
    [
      "altered Boolean grouping",
      `
      (("claim_token" IS NULL)
        AND ((("status" = 'planned'::guide_delivery_status)
          OR ("status" = 'failed'::guide_delivery_status))
          AND ("next_attempt_at" IS NOT NULL)))
      `,
    ],
  ])("rejects %s", (_label, predicate) => {
    expect(matchesExpectedDueIndexPredicate(predicate)).toBe(false);
  });
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

    const grants = await prisma.$queryRaw<
      Array<{ grantee: string; table_name: string }>
    >`
      SELECT grantee, table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('guide_delivery', 'guide_delivery_unit')
        AND grantee IN ('anon', 'authenticated')
      ORDER BY table_name, grantee
    `;
    expect(grants).toEqual([]);
  });

  it("creates exactly the planned enum values", async () => {
    const values = await prisma.$queryRaw<Array<{ enum_name: string; enum_value: string }>>`
      SELECT type_row.typname AS enum_name, value_row.enumlabel AS enum_value
      FROM pg_type type_row
      JOIN pg_enum value_row ON value_row.enumtypid = type_row.oid
      WHERE type_row.typname LIKE 'guide_delivery%'
      ORDER BY type_row.typname, value_row.enumsortorder
    `;

    expect(values).toEqual([
      { enum_name: "guide_delivery_failure_disposition", enum_value: "transient" },
      { enum_name: "guide_delivery_failure_disposition", enum_value: "permanent" },
      { enum_name: "guide_delivery_status", enum_value: "planned" },
      { enum_name: "guide_delivery_status", enum_value: "sending" },
      { enum_name: "guide_delivery_status", enum_value: "failed" },
      { enum_name: "guide_delivery_status", enum_value: "needs_review" },
      { enum_name: "guide_delivery_status", enum_value: "completed" },
      { enum_name: "guide_delivery_status", enum_value: "cancelled" },
      { enum_name: "guide_delivery_trigger_kind", enum_value: "inbound_reply" },
      { enum_name: "guide_delivery_trigger_kind", enum_value: "explicit_redelivery" },
      { enum_name: "guide_delivery_trigger_kind", enum_value: "follow_recovery" },
      { enum_name: "guide_delivery_unit_kind", enum_value: "text" },
      { enum_name: "guide_delivery_unit_kind", enum_value: "image" },
      { enum_name: "guide_delivery_unit_kind", enum_value: "file" },
      { enum_name: "guide_delivery_unit_origin", enum_value: "resource_step" },
      { enum_name: "guide_delivery_unit_origin", enum_value: "redelivery_intro" },
      // Appended last on purpose. The query orders by `enumsortorder`, so this
      // position is the proof that the migration added a value rather than
      // recreating the type and renumbering the two that delivery rows already use.
      { enum_name: "guide_delivery_unit_origin", enum_value: "generated_cover" },
      { enum_name: "guide_delivery_unit_status", enum_value: "pending" },
      { enum_name: "guide_delivery_unit_status", enum_value: "sending" },
      { enum_name: "guide_delivery_unit_status", enum_value: "sent" },
      { enum_name: "guide_delivery_unit_status", enum_value: "retryable" },
      { enum_name: "guide_delivery_unit_status", enum_value: "failed" },
      { enum_name: "guide_delivery_unit_status", enum_value: "uncertain" },
      { enum_name: "guide_delivery_unit_status", enum_value: "cancelled" },
    ]);
  });

  it("uses exact unique identities and leading full indexes for every foreign key", async () => {
    const indexes = await loadIndexMetadata();
    const byName = new Map(indexes.map((index) => [index.index_name, index]));

    expect(byName.get("guide_delivery_trigger_kind_trigger_id_key")).toMatchObject({
      included_columns: [],
      is_unique: true,
      is_valid: true,
      key_columns: ["trigger_kind", "trigger_id"],
      key_orders: ["ASC", "ASC"],
      predicate: null,
      table_name: "guide_delivery",
    });
    expect(byName.get("guide_delivery_unit_delivery_id_position_key")).toMatchObject({
      included_columns: [],
      is_unique: true,
      is_valid: true,
      key_columns: ["delivery_id", "position"],
      key_orders: ["ASC", "ASC"],
      predicate: null,
      table_name: "guide_delivery_unit",
    });

    const foreignKeys = await prisma.$queryRaw<
      Array<{ constraint_name: string; source_columns: string[]; source_table: string }>
    >`
      SELECT
        constraint_row.conname AS constraint_name,
        ARRAY(
          SELECT a.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS source_column(attnum, ordinal)
          JOIN pg_attribute a
            ON a.attrelid = constraint_row.conrelid
           AND a.attnum = source_column.attnum
          ORDER BY source_column.ordinal
        ) AS source_columns,
        source_table.relname AS source_table
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace n ON n.oid = source_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND n.nspname = 'public'
        AND source_table.relname IN ('guide_delivery', 'guide_delivery_unit')
      ORDER BY constraint_row.conname
    `;

    for (const foreignKey of foreignKeys) {
      const hasLeadingFullIndex = indexes.some(
        (index) =>
          index.table_name === foreignKey.source_table &&
          index.is_valid &&
          index.predicate === null &&
          foreignKey.source_columns.every(
            (column, position) => index.key_columns[position] === column,
          ),
      );
      expect(
        hasLeadingFullIndex,
        `${foreignKey.constraint_name} lacks a full index beginning with ${foreignKey.source_columns.join(", ")}`,
      ).toBe(true);
    }
  });

  it("binds every foreign key to the planned target and delete action", async () => {
    const foreignKeys = await prisma.$queryRaw<
      Array<{
        constraint_name: string;
        on_delete: string;
        source_columns: string[];
        source_table: string;
        target_columns: string[];
        target_table: string;
      }>
    >`
      SELECT
        constraint_row.conname AS constraint_name,
        CASE constraint_row.confdeltype
          WHEN 'r' THEN 'RESTRICT'
          WHEN 'n' THEN 'SET NULL'
          WHEN 'c' THEN 'CASCADE'
          ELSE constraint_row.confdeltype::text
        END AS on_delete,
        ARRAY(
          SELECT a.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS source_column(attnum, ordinal)
          JOIN pg_attribute a
            ON a.attrelid = constraint_row.conrelid
           AND a.attnum = source_column.attnum
          ORDER BY source_column.ordinal
        ) AS source_columns,
        source_table.relname AS source_table,
        ARRAY(
          SELECT a.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY AS target_column(attnum, ordinal)
          JOIN pg_attribute a
            ON a.attrelid = constraint_row.confrelid
           AND a.attnum = target_column.attnum
          ORDER BY target_column.ordinal
        ) AS target_columns,
        target_table.relname AS target_table
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_namespace n ON n.oid = source_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND n.nspname = 'public'
        AND source_table.relname IN ('guide_delivery', 'guide_delivery_unit')
      ORDER BY constraint_row.conname
    `;

    expect(foreignKeys).toEqual([
      {
        constraint_name: "guide_delivery_conversation_id_fkey",
        on_delete: "RESTRICT",
        source_columns: ["conversation_id"],
        source_table: "guide_delivery",
        target_columns: ["id"],
        target_table: "conversations",
      },
      {
        constraint_name: "guide_delivery_resource_id_fkey",
        on_delete: "RESTRICT",
        source_columns: ["resource_id"],
        source_table: "guide_delivery",
        target_columns: ["id"],
        target_table: "resources",
      },
      {
        constraint_name: "guide_delivery_thread_id_fkey",
        on_delete: "SET NULL",
        source_columns: ["thread_id"],
        source_table: "guide_delivery",
        target_columns: ["id"],
        target_table: "dm_thread",
      },
      {
        constraint_name: "guide_delivery_unit_delivery_id_fkey",
        on_delete: "CASCADE",
        source_columns: ["delivery_id"],
        source_table: "guide_delivery_unit",
        target_columns: ["id"],
        target_table: "guide_delivery",
      },
      {
        constraint_name: "guide_delivery_unit_resource_message_id_fkey",
        on_delete: "SET NULL",
        source_columns: ["resource_message_id"],
        source_table: "guide_delivery_unit",
        target_columns: ["id"],
        target_table: "resource_messages",
      },
    ]);
  });

  it("installs exact partial worker and review indexes", async () => {
    const indexes = await loadIndexMetadata();
    const byName = new Map(indexes.map((index) => [index.index_name, index]));

    expect(byName.get("guide_delivery_due_idx")).toMatchObject({
      included_columns: [],
      is_unique: false,
      is_valid: true,
      key_columns: ["next_attempt_at", "created_at", "id"],
      key_orders: ["ASC", "ASC", "ASC"],
      table_name: "guide_delivery",
    });
    expect(
      normalizeCatalogExpression(byName.get("guide_delivery_due_idx")?.predicate ?? null),
    ).toBe(EXPECTED_DUE_INDEX_PREDICATE);
    expect(byName.get("guide_delivery_expired_claim_idx")).toMatchObject({
      included_columns: [],
      is_unique: false,
      is_valid: true,
      key_columns: ["claim_expires_at", "id"],
      key_orders: ["ASC", "ASC"],
      table_name: "guide_delivery",
    });
    expect(
      normalizeCatalogExpression(byName.get("guide_delivery_expired_claim_idx")?.predicate ?? null),
    ).toBe("(claim_token is not null)");
    expect(byName.get("guide_delivery_thread_review_idx")).toMatchObject({
      included_columns: [],
      is_unique: false,
      is_valid: true,
      key_columns: ["thread_id", "created_at"],
      key_orders: ["ASC", "DESC"],
      table_name: "guide_delivery",
    });
    expect(
      normalizeCatalogExpression(byName.get("guide_delivery_thread_review_idx")?.predicate ?? null),
    ).toBe("(status = 'needs_review')");
    expect(findFullWorkerIndexLookalikes(indexes)).toEqual([]);
  });

  it("enforces the named delivery and unit check semantics", async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'public.guide_delivery'::regclass,
        'public.guide_delivery_unit'::regclass
      )
        AND contype = 'c'
    `;
    const byName = new Map(
      constraints.map((row) => [row.conname, normalizeCatalogExpression(row.definition)]),
    );

    expect(byName.get("guide_delivery_send_window_order_check")).toMatch(
      /send_window_expires_at > triggered_at/,
    );
    expect(byName.get("guide_delivery_claim_complete_check")).toMatch(
      /claim_token is null.*claimed_at is null.*claim_expires_at is null.*claim_token is not null.*claimed_at is not null.*claim_expires_at is not null.*claim_expires_at > claimed_at/,
    );
    expect(byName.get("guide_delivery_retry_shape_check")).toMatch(
      /next_attempt_at is null.*status = 'failed'/,
    );
    expect(byName.get("guide_delivery_terminal_timestamps_check")).toMatch(
      /status = 'completed'.*completed_at is not null.*cancelled_at is null.*status = 'cancelled'.*cancelled_at is not null.*completed_at is null/,
    );
    expect(byName.get("guide_delivery_unit_position_check")).toMatch(/position >= 0/);
    expect(byName.get("guide_delivery_unit_payload_shape_check")).toMatch(
      /kind = 'text'.*text_snapshot is not null.*media_url_snapshot is null.*kind = any.*image.*file.*text_snapshot is null.*media_url_snapshot is not null/,
    );
    expect(byName.get("guide_delivery_unit_attempts_check")).toMatch(/attempts >= 0/);
    expect(byName.get("guide_delivery_unit_state_timestamps_check")).toMatch(
      /pending.*sending.*retryable.*failed.*uncertain.*sent.*cancelled/,
    );
    expect(byName.get("guide_delivery_unit_sent_state_check")).toMatch(
      /status <> 'sent'.*provider_message_id.*owner_confirmed_at/,
    );
    expect(byName.get("guide_delivery_unit_owner_retry_order_check")).toMatch(
      /owner_retry_consumed_at is null.*owner_retry_authorized_at is not null.*owner_retry_consumed_at >= owner_retry_authorized_at/,
    );
  });

  it("uses TIMESTAMPTZ(3) for every ledger timestamp", async () => {
    const timestamps = await prisma.$queryRaw<
      Array<{ column_name: string; datetime_precision: number; table_name: string }>
    >`
      SELECT table_name, column_name, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('guide_delivery', 'guide_delivery_unit')
        AND data_type = 'timestamp with time zone'
      ORDER BY table_name, ordinal_position
    `;

    expect(timestamps).toEqual(
      [
        "triggered_at",
        "send_window_expires_at",
        "next_attempt_at",
        "claimed_at",
        "claim_expires_at",
        "started_at",
        "completed_at",
        "cancelled_at",
        "created_at",
        "updated_at",
      ]
        .map((column_name) => ({ table_name: "guide_delivery", column_name, datetime_precision: 3 }))
        .concat(
          [
            "sending_at",
            "sent_at",
            "owner_confirmed_at",
            "owner_retry_authorized_at",
            "owner_retry_consumed_at",
            "created_at",
            "updated_at",
          ].map((column_name) => ({
            table_name: "guide_delivery_unit",
            column_name,
            datetime_precision: 3,
          })),
        ),
    );
  });

  it("uses immutable snapshot, owner acknowledgement, and allowlisted error columns", async () => {
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
        AND (
          column_name IN (
            'text_snapshot',
            'media_url_snapshot',
            'content_fingerprint',
            'owner_confirmed_at',
            'owner_retry_authorized_at',
            'owner_retry_consumed_at'
          )
          OR column_name LIKE 'error_%'
        )
      ORDER BY column_name
    `;

    expect(columns).toEqual([
      { character_maximum_length: 64, column_name: "content_fingerprint", data_type: "character", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_category", data_type: "text", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_graph_code", data_type: "integer", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_graph_subcode", data_type: "integer", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_http_status", data_type: "integer", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_trace_id", data_type: "text", datetime_precision: null },
      { character_maximum_length: null, column_name: "error_transport_code", data_type: "text", datetime_precision: null },
      { character_maximum_length: null, column_name: "media_url_snapshot", data_type: "text", datetime_precision: null },
      { character_maximum_length: null, column_name: "owner_confirmed_at", data_type: "timestamp with time zone", datetime_precision: 3 },
      { character_maximum_length: null, column_name: "owner_retry_authorized_at", data_type: "timestamp with time zone", datetime_precision: 3 },
      { character_maximum_length: null, column_name: "owner_retry_consumed_at", data_type: "timestamp with time zone", datetime_precision: 3 },
      { character_maximum_length: null, column_name: "text_snapshot", data_type: "text", datetime_precision: null },
    ]);
  });

  it("does not ask Prisma to replace partial worker indexes with full indexes", () => {
    const diff = execFileSync(
      path.resolve("node_modules/.bin/prisma"),
      [
        "migrate",
        "diff",
        "--from-url",
        databaseUrl!,
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--script",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );

    expect(findProtectedWorkerIndexDrift(diff)).toEqual([]);
  });
});
