import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260818010000_add_flag_override/migration.sql",
  import.meta.url,
);

describe("flag override migration contract", () => {
  it("stores values only, keyed by the environment variable name", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`CREATE TABLE "flag_override"`);
    expect(sql).toContain(`"key" TEXT NOT NULL`);
    expect(sql).toContain(`CONSTRAINT "flag_override_pkey" PRIMARY KEY ("key")`);
    // Descriptions live in src/config/flagRegistry.ts. A column here would be a
    // second source of truth that nothing forces anyone to fill in.
    expect(sql).not.toMatch(/does_what|affects_who|if_off/);
  });

  // A row with neither value is meaningless, and a row with both does not say
  // which kind of flag it belongs to — the resolver would have to guess.
  it("requires exactly one of the two value columns", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`CONSTRAINT "flag_override_one_value_check"`);
    expect(sql).toMatch(/num_nonnulls\("value_bool",\s*"value_percent"\)\s*=\s*1/);
  });

  it("bounds a percentage to 0-100", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toMatch(/"value_percent" IS NULL OR \("value_percent" BETWEEN 0 AND 100\)/);
  });

  it("records who changed it", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`"updated_by" TEXT NOT NULL`);
  });

  it("enables row level security without a browser-facing policy", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`ALTER TABLE "flag_override" ENABLE ROW LEVEL SECURITY`);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });
});
