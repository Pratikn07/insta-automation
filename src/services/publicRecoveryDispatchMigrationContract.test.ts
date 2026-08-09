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

describeWithDatabase("public recovery dispatch migration", () => {
  it("creates the backend-only dispatch ledger", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; table_name: string }>
    >`
      SELECT c.relrowsecurity, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'public_recovery_dispatch'
    `;
    expect(rows).toEqual([
      { relrowsecurity: true, table_name: "public_recovery_dispatch" },
    ]);

    const grants = await prisma.$queryRaw<Array<{ grantee: string }>>`
      SELECT grantee
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'public_recovery_dispatch'
        AND grantee IN ('anon', 'authenticated')
    `;
    expect(grants).toEqual([]);
  });

  it("enforces exclusive active person and source attempt indexes", async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'public_recovery_dispatch'
      ORDER BY indexname
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get("public_recovery_dispatch_source_attempt_key")).toContain(
      "source_kind, source_id, attempt_number",
    );
    expect(byName.get("public_recovery_dispatch_active_person_key")).toMatch(
      /UNIQUE.*ig_user_id.*reserved.*dispatch_started/i,
    );
    expect(byName.has("public_recovery_dispatch_capacity_idx")).toBe(true);
    expect(byName.get("public_recovery_dispatch_person_cooldown_idx")).toContain(
      "ig_user_id, dispatch_started_at",
    );
  });

  it("installs state-shape and lease-order constraints", async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.public_recovery_dispatch'::regclass
      ORDER BY conname
    `;
    expect(constraints.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "public_recovery_dispatch_state_shape_check",
        "public_recovery_dispatch_lease_order_check",
        "public_recovery_dispatch_attempt_number_check",
      ]),
    );
  });

  it("adds complete prospective claim fencing", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dm_recovery_reminder'
        AND column_name = 'claim_token'
    `;
    expect(columns).toEqual([{ column_name: "claim_token", data_type: "uuid" }]);

    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.dm_recovery_reminder'::regclass
    `;
    expect(constraints.map((row) => row.conname)).toContain(
      "dm_recovery_reminder_claim_complete_check",
    );
  });
});
