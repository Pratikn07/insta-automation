import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260921030000_add_guide_audience_authorization/migration.sql",
  import.meta.url,
);

describe("guide audience authorization migration contract", () => {
  it("creates the isolated audience provenance vocabulary and tables", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      `CREATE TYPE "guide_audience_origin" AS ENUM ('south_asian', 'us_western', 'other', 'unknown')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "guide_audience_confidence" AS ENUM ('high', 'low')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "guide_audience_decision_kind" AS ENUM ('block', 'defer')`,
    );
    expect(sql).toContain(`CREATE TYPE "guide_audience_action_source"`);
    expect(sql).toContain(`CREATE TYPE "guide_audience_defer_reason"`);
    expect(sql).toContain(`CREATE TABLE "guide_audience_classification"`);
    expect(sql).toContain(`CREATE TABLE "guide_audience_decision"`);
    expect(sql).toContain(`"identity_hash" CHAR(64) NOT NULL`);
    expect(sql).toContain(`"evidence" VARCHAR(200) NOT NULL`);
    expect(sql).toContain(`"classified_at" TIMESTAMPTZ(3) NOT NULL`);
  });

  it("uses exact-snapshot cache and audit access paths with durable foreign keys", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      `CREATE UNIQUE INDEX "guide_audience_classification_ig_user_id_identity_hash_method_key"`,
    );
    expect(sql).toContain(
      `ON "guide_audience_classification"("ig_user_id", "identity_hash", "method")`,
    );
    expect(sql).toContain(
      `CREATE INDEX "guide_audience_decision_ig_user_id_created_at_idx"`,
    );
    expect(sql).toContain(`CREATE INDEX "guide_audience_decision_kind_created_at_idx"`);
    expect(sql).toMatch(
      /FOREIGN KEY \("ig_user_id"\) REFERENCES "ig_users"\("id"\)\s+ON DELETE RESTRICT/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("classification_id"\) REFERENCES "guide_audience_classification"\("id"\)\s+ON DELETE SET NULL/i,
    );
  });

  it("keeps the service-only tables private from browser roles", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(`ALTER TABLE "guide_audience_classification" ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain(`ALTER TABLE "guide_audience_decision" ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain(`REVOKE ALL ON TABLE "guide_audience_classification" FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON TABLE "guide_audience_decision" FROM authenticated`);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });
});
