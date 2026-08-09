import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (db) await db.$disconnect();
});

describeWithLocalDatabase("historical recovery origin method migration contract", () => {
  it("adds a nullable audience origin method column to frozen candidates", async () => {
    const rows = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'recovery_candidate'
        AND column_name = 'audience_origin_method'
    `;

    expect(rows).toEqual([{ column_name: "audience_origin_method", is_nullable: "YES" }]);
  });
});
