import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260817010000_add_upcoming_automations/migration.sql",
  import.meta.url,
);

describe("upcoming automation migration contract", () => {
  it("creates the lifecycle table, enum, indexed foreign keys, and reservation fence", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      `CREATE TYPE "upcoming_automation_status" AS ENUM ('waiting', 'bound', 'needs_attention', 'cancelled')`,
    );
    expect(sql).toContain(`CREATE TABLE "upcoming_automations"`);
    expect(sql).toContain(
      `CREATE INDEX "upcoming_automations_resource_id_idx" ON "upcoming_automations"("resource_id")`,
    );
    expect(sql).toContain(
      `CREATE INDEX "upcoming_automations_keyword_id_idx" ON "upcoming_automations"("keyword_id")`,
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "upcoming_automations_open_trigger_word_key"`,
    );
    expect(sql).toContain(`WHERE "status" IN ('waiting', 'needs_attention')`);
  });

  it("enables RLS without creating browser-facing policies", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`ALTER TABLE "upcoming_automations" ENABLE ROW LEVEL SECURITY`);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });

  it("enforces normalized words and terminal lifecycle consistency", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`CHECK ("trigger_word" ~ '^[A-Z0-9]+$'`);
    expect(sql).toContain(`CHECK ("status" != 'bound' OR ("matched_media_id" IS NOT NULL AND "bound_at" IS NOT NULL))`);
    expect(sql).toContain(`CHECK ("status" != 'cancelled' OR "cancelled_at" IS NOT NULL)`);
  });
});
