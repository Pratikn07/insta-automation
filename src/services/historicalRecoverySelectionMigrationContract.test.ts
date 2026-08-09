import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(parsed.hostname);
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (db) await db.$disconnect();
});

describeWithDatabase("P1 selection and attribution migration", () => {
  it("adds the reviewed-manifest identity and explicit measurement windows", async () => {
    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'recovery_campaign'
        AND column_name IN (
          'selection_fingerprint',
          'eligibility_policy_version',
          'western_only',
          'inbound_window_hours',
          'completion_window_hours'
        )
      ORDER BY column_name
    `;

    expect(columns.map((row) => row.column_name)).toEqual([
      "completion_window_hours",
      "eligibility_policy_version",
      "inbound_window_hours",
      "selection_fingerprint",
      "western_only",
    ]);
  });

  it("adds immutable ordered candidate source evidence", async () => {
    const [{ source_table: sourceTable, relrowsecurity }] = await db.$queryRaw<
      Array<{ source_table: string | null; relrowsecurity: boolean | null }>
    >`
      SELECT
        to_regclass('public.recovery_candidate_source')::text AS source_table,
        c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'recovery_candidate_source'
    `;
    expect(sourceTable).toBe("recovery_candidate_source");
    expect(relrowsecurity).toBe(true);

    const candidateColumns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'recovery_candidate'
        AND column_name IN ('source_choice_reason', 'dispatch_comment_id')
      ORDER BY column_name
    `;
    expect(candidateColumns.map((row) => row.column_name)).toEqual([
      "dispatch_comment_id",
      "source_choice_reason",
    ]);
  });

  it("creates the normalized snapshot and source-order uniqueness indexes", async () => {
    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'recovery_campaign_selection_fingerprint_key',
          'recovery_candidate_source_candidate_id_position_key',
          'recovery_candidate_source_candidate_id_comment_id_key'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "recovery_campaign_selection_fingerprint_key",
      "recovery_candidate_source_candidate_id_comment_id_key",
      "recovery_candidate_source_candidate_id_position_key",
    ]);
  });
});
