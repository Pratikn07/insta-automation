import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe : describe.skip;

type TimestampColumn = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

describeWithLocalDatabase("owner-approved follow-up database contract", () => {
  it("stores scheduling and deadline instants with time zones in migrations and the Prisma schema", async () => {
    const parsedUrl = new URL(databaseUrl!);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(parsedUrl.hostname);

    const declaredSchema = "task2_timezone_schema_contract";
    const declaredSchemaUrl = new URL(databaseUrl!);
    declaredSchemaUrl.searchParams.set("schema", declaredSchema);
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${declaredSchema}" CASCADE`);
      execFileSync(
        path.resolve("node_modules/.bin/prisma"),
        ["db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: declaredSchemaUrl.toString() },
          stdio: "pipe",
        },
      );

      const columns = await prisma.$queryRawUnsafe<TimestampColumn[]>(`
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema IN ('public', '${declaredSchema}')
          AND (table_name, column_name) IN (
            ('conversations', 'engagement_follow_up_scheduled_at'),
            ('reply_draft', 'eligible_at'),
            ('reply_draft', 'expires_at')
          )
        ORDER BY table_schema, table_name, column_name
      `);

      expect(columns).toEqual([
        {
          table_schema: "public",
          table_name: "conversations",
          column_name: "engagement_follow_up_scheduled_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: "public",
          table_name: "reply_draft",
          column_name: "eligible_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: "public",
          table_name: "reply_draft",
          column_name: "expires_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "conversations",
          column_name: "engagement_follow_up_scheduled_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "reply_draft",
          column_name: "eligible_at",
          data_type: "timestamp with time zone",
        },
        {
          table_schema: declaredSchema,
          table_name: "reply_draft",
          column_name: "expires_at",
          data_type: "timestamp with time zone",
        },
      ]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${declaredSchema}" CASCADE`);
      await prisma.$disconnect();
    }
  });
});
