import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

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
});

type TimestampColumn = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

describeWithLocalDatabase("dm recovery database contract", () => {
  it("creates the recovery state machine with RLS and idempotency constraints", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('DmRecoveryReminder', 'DmRecoveryControl')
        ORDER BY table_name
      `;
      expect(tables.map((row) => row.table_name)).toEqual([
        "DmRecoveryControl",
        "DmRecoveryReminder",
      ]);

      const rls = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity
        FROM pg_class
        WHERE relname IN ('DmRecoveryReminder', 'DmRecoveryControl')
        ORDER BY relname
      `;
      expect(rls).toEqual([
        { relname: "DmRecoveryControl", relrowsecurity: true },
        { relname: "DmRecoveryReminder", relrowsecurity: true },
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("stores all recovery and added timestamps with time zone", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
      const columns = await prisma.$queryRaw<TimestampColumn[]>`
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'DmRecoveryReminder' AND column_name IN ('eligible_at', 'accepted_at', 'seen_at', 'sent_at'))
            OR (table_name = 'dm_messages' AND column_name IN ('seen_at', 'deleted_at'))
            OR (table_name = 'gate_queue' AND column_name IN ('claimed_at', 'claim_expires_at'))
          )
        ORDER BY table_name, column_name
      `;

      expect(columns.length).toBeGreaterThanOrEqual(8);
      for (const col of columns) {
        expect(col.data_type).toBe("timestamp with time zone");
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it("ensures singleton control row with id = 1", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
      const control = await prisma.$queryRaw<Array<{ id: number; circuit_open: boolean }>>`
        SELECT id, circuit_open FROM "DmRecoveryControl" WHERE id = 1
      `;
      expect(control).toHaveLength(1);
      expect(control[0]?.circuit_open).toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });
});
