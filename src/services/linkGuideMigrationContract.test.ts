import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (db) await db.$disconnect();
});

describeWithLocalDatabase("link guide migration contract", () => {
  it("defaults existing and new guides to gated", async () => {
    const rows = await db.$queryRaw<Array<{ column_default: string | null; is_nullable: string }>>`
      SELECT column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'resources' AND column_name = 'delivery_mode'
    `;
    expect(rows).toEqual([{ column_default: "'gated'::guide_delivery_mode", is_nullable: "NO" }]);
  });

  it("appends link_sent to the conversation states", async () => {
    const rows = await db.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'conversation_state'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual(["awaiting_done", "completed", "expired", "link_sent"]);
  });

  it("enables row level security on both new tables", async () => {
    const rows = await db.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('guide_link_send', 'guide_link_click')
      ORDER BY relname
    `;
    expect(rows).toEqual([
      { relname: "guide_link_click", relrowsecurity: true },
      { relname: "guide_link_send", relrowsecurity: true },
    ]);
  });
});
