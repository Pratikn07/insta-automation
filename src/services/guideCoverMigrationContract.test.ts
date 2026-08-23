import { readFile } from "node:fs/promises";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GUIDE_COVER_CATEGORIES } from "../../shared/guideCoverRegistry.js";

const migrationUrl = new URL(
  "../../prisma/migrations/20260822010000_add_guide_cover_authoring/migration.sql",
  import.meta.url,
);
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const TABLES = [
  "guide_cover_orphan",
  "presentation_category",
  "resource_cover_suggestion",
  "resource_cover_version",
  "resource_presentation",
] as const;

let prisma: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1", "[::1]"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("guide cover authoring migration source contract", () => {
  it("declares the exact lowercase tables and lifecycle enums", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const enumName of [
      "presentation_category_design_status",
      "resource_cover_status",
      "resource_cover_render_status",
      "resource_cover_suggestion_confidence",
      "guide_cover_orphan_cleanup_status",
    ]) {
      expect(sql).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }
  });

  it("seeds the four approved registry identities without changing visual keys", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    for (const category of Object.values(GUIDE_COVER_CATEGORIES)) {
      expect(sql).toContain(`'${category.categorySlug}'`);
      expect(sql).toContain(`'${category.defaultKicker}'`);
      expect(sql).toContain(`'${category.collectionLabel}'`);
      expect(sql).toContain(`'${category.templateKey}'`);
      expect(sql).toContain(`'${category.paletteKey}'`);
      expect(sql).toContain(`'${category.illustrationKey}'`);
    }
    expect(sql).toMatch(/ON CONFLICT \("id"\) DO NOTHING/);
    expect(sql).toMatch(/approved guide-cover category seed mismatch/i);
  });

  it("enables RLS and revokes browser-role privileges on every table", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    for (const table of TABLES) {
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      expect(sql).toContain(
        `REVOKE ALL ON TABLE "${table}" FROM "anon", "authenticated"`,
      );
    }
    expect(sql).not.toMatch(/CREATE\s+POLICY/iu);
  });
});

describeWithDatabase("guide cover authoring PostgreSQL contract", () => {
  it("creates server-owned RLS tables with no client grants", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; table_name: string }>
    >`
      SELECT c.relrowsecurity, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'guide_cover_orphan',
          'presentation_category',
          'resource_cover_suggestion',
          'resource_cover_version',
          'resource_presentation'
        )
      ORDER BY c.relname
    `;
    expect(tables).toEqual(
      TABLES.map((table_name) => ({ table_name, relrowsecurity: true })),
    );

    const grants = await prisma.$queryRaw<
      Array<{ grantee: string; table_name: string }>
    >`
      SELECT grantee, table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN (
          'guide_cover_orphan',
          'presentation_category',
          'resource_cover_suggestion',
          'resource_cover_version',
          'resource_presentation'
        )
        AND grantee IN ('anon', 'authenticated')
    `;
    expect(grants).toEqual([]);
  });

  it("creates the exact enum values", async () => {
    const values = await prisma.$queryRaw<
      Array<{ enum_name: string; enum_value: string }>
    >`
      SELECT type_row.typname AS enum_name, value_row.enumlabel AS enum_value
      FROM pg_type type_row
      JOIN pg_enum value_row ON value_row.enumtypid = type_row.oid
      WHERE type_row.typname IN (
        'presentation_category_design_status',
        'resource_cover_status',
        'resource_cover_render_status',
        'resource_cover_suggestion_confidence',
        'guide_cover_orphan_cleanup_status'
      )
      ORDER BY type_row.typname, value_row.enumsortorder
    `;

    expect(values).toEqual([
      { enum_name: "guide_cover_orphan_cleanup_status", enum_value: "pending" },
      { enum_name: "guide_cover_orphan_cleanup_status", enum_value: "claimed" },
      { enum_name: "guide_cover_orphan_cleanup_status", enum_value: "deleted" },
      {
        enum_name: "guide_cover_orphan_cleanup_status",
        enum_value: "needs_review",
      },
      {
        enum_name: "presentation_category_design_status",
        enum_value: "ready",
      },
      {
        enum_name: "presentation_category_design_status",
        enum_value: "needs_review",
      },
      {
        enum_name: "presentation_category_design_status",
        enum_value: "inactive",
      },
      { enum_name: "resource_cover_render_status", enum_value: "not_rendered" },
      { enum_name: "resource_cover_render_status", enum_value: "rendering" },
      { enum_name: "resource_cover_render_status", enum_value: "ready" },
      { enum_name: "resource_cover_render_status", enum_value: "failed" },
      { enum_name: "resource_cover_status", enum_value: "draft" },
      { enum_name: "resource_cover_status", enum_value: "approved" },
      { enum_name: "resource_cover_status", enum_value: "published" },
      { enum_name: "resource_cover_status", enum_value: "retired" },
      { enum_name: "resource_cover_suggestion_confidence", enum_value: "high" },
      { enum_name: "resource_cover_suggestion_confidence", enum_value: "medium" },
      { enum_name: "resource_cover_suggestion_confidence", enum_value: "low" },
    ]);
  });

  it("indexes every foreign key with its source columns first", async () => {
    const missing = await prisma.$queryRaw<
      Array<{ constraint_name: string; source_table: string }>
    >`
      SELECT constraint_row.conname AS constraint_name,
             source_table.relname AS source_table
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace n ON n.oid = source_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND n.nspname = 'public'
        AND source_table.relname IN (
          'guide_cover_orphan',
          'presentation_category',
          'resource_cover_suggestion',
          'resource_cover_version',
          'resource_presentation'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_index index_row
          WHERE index_row.indrelid = constraint_row.conrelid
            AND index_row.indisvalid
            AND index_row.indpred IS NULL
            AND ARRAY(
              SELECT indexed_column.attnum
              FROM unnest(index_row.indkey::smallint[])
                WITH ORDINALITY AS indexed_column(attnum, ordinal)
              WHERE indexed_column.ordinal <= cardinality(constraint_row.conkey)
              ORDER BY indexed_column.ordinal
            ) = constraint_row.conkey
        )
    `;
    expect(missing).toEqual([]);
  });

  it("uses only the planned foreign-key delete actions", async () => {
    const foreignKeys = await prisma.$queryRaw<
      Array<{ constraint_name: string; on_delete: string }>
    >`
      SELECT constraint_row.conname AS constraint_name,
        CASE constraint_row.confdeltype
          WHEN 'r' THEN 'RESTRICT'
          WHEN 'n' THEN 'SET NULL'
          ELSE constraint_row.confdeltype::text
        END AS on_delete
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace n ON n.oid = source_table.relnamespace
      WHERE constraint_row.contype = 'f'
        AND n.nspname = 'public'
        AND source_table.relname IN (
          'guide_cover_orphan',
          'resource_cover_suggestion',
          'resource_cover_version',
          'resource_presentation'
        )
      ORDER BY constraint_row.conname
    `;
    expect(foreignKeys).toEqual([
      { constraint_name: "guide_cover_orphan_cover_version_id_fkey", on_delete: "RESTRICT" },
      { constraint_name: "guide_cover_orphan_resource_id_fkey", on_delete: "RESTRICT" },
      {
        constraint_name: "resource_cover_suggestion_resource_id_fkey",
        on_delete: "RESTRICT",
      },
      {
        constraint_name: "resource_cover_suggestion_suggested_category_id_fkey",
        on_delete: "RESTRICT",
      },
      { constraint_name: "resource_cover_version_category_id_fkey", on_delete: "RESTRICT" },
      { constraint_name: "resource_cover_version_resource_id_fkey", on_delete: "RESTRICT" },
      { constraint_name: "resource_cover_version_suggestion_id_fkey", on_delete: "SET NULL" },
      { constraint_name: "resource_presentation_category_id_fkey", on_delete: "RESTRICT" },
      { constraint_name: "resource_presentation_resource_id_fkey", on_delete: "RESTRICT" },
    ]);
  });

  it("installs case-insensitive category and publication uniqueness", async () => {
    const indexes = await prisma.$queryRaw<
      Array<{ index_name: string; predicate: string | null; unique: boolean }>
    >`
      SELECT index_row.relname AS index_name,
             pg_get_expr(index_catalog.indpred, index_catalog.indrelid) AS predicate,
             index_catalog.indisunique AS unique
      FROM pg_index index_catalog
      JOIN pg_class index_row ON index_row.oid = index_catalog.indexrelid
      JOIN pg_class table_row ON table_row.oid = index_catalog.indrelid
      JOIN pg_namespace n ON n.oid = table_row.relnamespace
      WHERE n.nspname = 'public'
        AND index_row.relname IN (
          'presentation_category_slug_ci_key',
          'presentation_category_name_ci_key',
          'resource_presentation_category_edition_key',
          'resource_cover_version_one_published_key'
        )
      ORDER BY index_row.relname
    `;
    expect(indexes).toHaveLength(4);
    expect(indexes.every((index) => index.unique)).toBe(true);
    expect(
      indexes.find(
        (index) => index.index_name === "resource_presentation_category_edition_key",
      )?.predicate,
    ).toMatch(/edition_number IS NOT NULL/i);
    expect(
      indexes.find(
        (index) => index.index_name === "resource_cover_version_one_published_key",
      )?.predicate,
    ).toMatch(/status = 'published'/i);
  });

  it("seeds the exact approved category registry", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        collection_label: string;
        default_kicker: string;
        illustration_key: string;
        palette_key: string;
        slug: string;
        template_key: string;
      }>
    >`
      SELECT slug, default_kicker, collection_label, template_key, palette_key,
             illustration_key
      FROM presentation_category
      ORDER BY sort_order
    `;
    expect(rows).toEqual(
      Object.values(GUIDE_COVER_CATEGORIES).map((category) => ({
        slug: category.categorySlug,
        default_kicker: category.defaultKicker,
        collection_label: category.collectionLabel,
        template_key: category.templateKey,
        palette_key: category.paletteKey,
        illustration_key: category.illustrationKey,
      })),
    );
  });

  it("enforces case-insensitive category identity", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO presentation_category (
          id, slug, name, collection_label, default_kicker, template_key,
          palette_key, illustration_key, design_status, created_by, updated_by
        ) VALUES (
          '20000000-0000-4000-8000-000000000001'::uuid,
          'bedtime-copy', 'bedtime', 'SLEEP', 'A TINY WIN FOR TONIGHT',
          'warm_editorial_corner_v1', 'bedtime_blush_v1',
          'bedtime_window_house_v1', 'ready', 'contract-test', 'contract-test'
        )
      `,
    ).rejects.toThrow();
  });

  it("enforces copy limits and a complete published snapshot", async () => {
    const resourceId = "20000000-0000-4000-8000-000000000010";
    await prisma.$executeRaw`
      INSERT INTO resources (id, name)
      VALUES (${resourceId}::uuid, 'Guide cover contract resource')
    `;

    await expect(
      prisma.$executeRaw`
        INSERT INTO resource_cover_version (
          id, resource_id, revision, category_id, template_key, palette_key,
          illustration_key, kicker, collection_label, headline,
          supporting_line, closing_line, alternative_description
        ) VALUES (
          '20000000-0000-4000-8000-000000000011'::uuid,
          ${resourceId}::uuid, 1,
          '10000000-0000-4000-8000-000000000001'::uuid,
          'warm_editorial_corner_v1', 'bedtime_blush_v1',
          'bedtime_window_house_v1', 'A TINY WIN FOR TONIGHT', 'SLEEP',
          ${"x".repeat(57)}, 'A calmer bedtime.', 'Prepared with care.',
          'A valid alternative description.'
        )
      `,
    ).rejects.toThrow();

    await expect(
      prisma.$executeRaw`
        INSERT INTO resource_cover_version (
          id, resource_id, revision, status, render_status, category_id,
          edition_number, template_key, palette_key, illustration_key, kicker,
          collection_label, headline, supporting_line, closing_line,
          alternative_description, approved_by, approved_at, published_by,
          published_at
        ) VALUES (
          '20000000-0000-4000-8000-000000000012'::uuid,
          ${resourceId}::uuid, 1, 'published', 'not_rendered',
          '10000000-0000-4000-8000-000000000001'::uuid, 1,
          'warm_editorial_corner_v1', 'bedtime_blush_v1',
          'bedtime_window_house_v1', 'A TINY WIN FOR TONIGHT', 'SLEEP',
          'Bedtime can feel softer', 'A calmer bedtime.', 'Prepared with care.',
          'A valid alternative description.', 'contract-test', CURRENT_TIMESTAMP,
          'contract-test', CURRENT_TIMESTAMP
        )
      `,
    ).rejects.toThrow();
  });

  it("allows only one published cover and one category edition", async () => {
    const resourceId = "20000000-0000-4000-8000-000000000020";
    const secondResourceId = "20000000-0000-4000-8000-000000000021";
    const thirdResourceId = "20000000-0000-4000-8000-000000000022";
    const coverId = "20000000-0000-4000-8000-000000000023";
    const secondCoverId = "20000000-0000-4000-8000-000000000024";
    const hash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    await prisma.$executeRaw`
      INSERT INTO resources (id, name) VALUES
        (${resourceId}::uuid, 'Published cover contract resource'),
        (${secondResourceId}::uuid, 'Edition contract resource one'),
        (${thirdResourceId}::uuid, 'Edition contract resource two')
    `;
    await prisma.$executeRaw`
      INSERT INTO resource_cover_version (
        id, resource_id, revision, status, render_status, category_id,
        edition_number, template_key, palette_key, illustration_key, kicker,
        collection_label, headline, supporting_line, closing_line,
        alternative_description, content_hash, dm_storage_path, approved_by,
        approved_at, published_by, published_at
      ) VALUES (
        ${coverId}::uuid, ${resourceId}::uuid, 1, 'published', 'ready',
        '10000000-0000-4000-8000-000000000001'::uuid, 1,
        'warm_editorial_corner_v1', 'bedtime_blush_v1',
        'bedtime_window_house_v1', 'A TINY WIN FOR TONIGHT', 'SLEEP',
        'Bedtime can feel softer', 'A calmer bedtime.', 'Prepared with care.',
        'A valid alternative description.', ${hash},
        ${`guide-cover/${resourceId}/${coverId}/${hash}/dm.png`},
        'contract-test', CURRENT_TIMESTAMP, 'contract-test', CURRENT_TIMESTAMP
      )
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO resource_cover_version (
          id, resource_id, revision, status, render_status, category_id,
          edition_number, template_key, palette_key, illustration_key, kicker,
          collection_label, headline, supporting_line, closing_line,
          alternative_description, content_hash, dm_storage_path, approved_by,
          approved_at, published_by, published_at
        ) VALUES (
          ${secondCoverId}::uuid, ${resourceId}::uuid, 2, 'published', 'ready',
          '10000000-0000-4000-8000-000000000001'::uuid, 1,
          'warm_editorial_corner_v1', 'bedtime_blush_v1',
          'bedtime_window_house_v1', 'A second bedtime', 'SLEEP',
          'Another valid headline', 'A calmer bedtime.', 'Prepared with care.',
          'A valid alternative description.', ${secondHash},
          ${`guide-cover/${resourceId}/${secondCoverId}/${secondHash}/dm.png`},
          'contract-test', CURRENT_TIMESTAMP, 'contract-test', CURRENT_TIMESTAMP
        )
      `,
    ).rejects.toThrow();

    await prisma.$executeRaw`
      INSERT INTO resource_presentation (resource_id, category_id, edition_number)
      VALUES (
        ${secondResourceId}::uuid,
        '10000000-0000-4000-8000-000000000001'::uuid,
        101
      )
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO resource_presentation (resource_id, category_id, edition_number)
        VALUES (
          ${thirdResourceId}::uuid,
          '10000000-0000-4000-8000-000000000001'::uuid,
          101
        )
      `,
    ).rejects.toThrow();
  });

  it("uses timestamptz(3) for all authoring audit timestamps", async () => {
    const invalid = await prisma.$queryRaw<
      Array<{ column_name: string; table_name: string }>
    >`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'guide_cover_orphan',
          'presentation_category',
          'resource_cover_suggestion',
          'resource_cover_version',
          'resource_presentation'
        )
        AND column_name ~ '(_at|created_at|updated_at)$'
        AND (
          data_type <> 'timestamp with time zone'
          OR datetime_precision <> 3
        )
    `;
    expect(invalid).toEqual([]);
  });
});
